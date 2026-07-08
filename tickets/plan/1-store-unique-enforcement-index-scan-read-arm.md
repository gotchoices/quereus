description: In the persistent store, checking a UNIQUE constraint rescans the whole table for every row inserted, so bulk inserts get quadratically slow; secondary indexes are already written to disk but never read to make this fast.
files:
  - packages/quereus-store/src/common/store-table.ts       # UNIQUE enforcement full-scan (~1451); query() PK-only scan (~636)
  - packages/quereus-store/src/common/store-module.ts       # getBestAccessPlan / access-plan surface (~1856)
  - packages/quereus-store/src/common/encoding.ts           # encodeCompositeKey — index key layout
difficulty: hard
----

# Store: implement the secondary-index scan read arm (fix O(n²) UNIQUE + enable index reads)

## Problem

The store maintains secondary indexes on the write path — every insert/update/
delete pays the per-index delete+put maintenance cost to keep index entries in
sync — but **nothing ever reads those index entries**. Two consequences follow
from the missing read arm:

1. **UNIQUE enforcement full-scans the table, per constraint, per row.**
   To check whether an incoming row violates a UNIQUE constraint, the store
   scans the entire table (`store-table.ts` ~1451) looking for a collision
   rather than doing a point lookup into the corresponding unique index. A bulk
   insert of *n* rows into a table with a UNIQUE constraint is therefore
   O(n²): row *k* scans the *k* rows already present.

2. **`query()` only supports primary-key scans.** The store's read path
   (`store-table.ts` ~636, surfaced through `getBestAccessPlan` in
   `store-module.ts` ~1856) can seek/scan by primary key only. A predicate on a
   secondary-indexed column cannot be answered by an index seek — it falls back
   to a full table scan even though a usable index exists on disk.

The writers are already paying full index-maintenance cost for indexes that
deliver zero read benefit. This is both a correctness-adjacent performance cliff
(bulk load latency) and a wasted-work design gap.

## Expected behavior

- A UNIQUE-constraint check for one row is a point lookup into that constraint's
  unique index (O(log n) / O(1)-ish), not a table scan — bulk insert with UNIQUE
  constraints becomes roughly O(n log n), not O(n²).
- `getBestAccessPlan` can report a secondary-index access path (point/range) for
  predicates on indexed columns, and `query()` can service it by iterating the
  index key space and resolving to rows — mirroring how the PK range-seek
  already works, but keyed on the secondary index.

## Direction (design to resolve in this plan)

The core work is a **secondary-index scan read arm**: given an index and a
predicate over its leading column(s), derive an encoded byte window over the
index key space (reuse the `encodeCompositeKey` / PK range-seek bound-builder
machinery), iterate it, and resolve each index entry to the base row (the index
entry must carry, or let you reconstruct, the base primary key). Then:

- Route UNIQUE checks through a point lookup on the appropriate unique index
  instead of the full-scan path.
- Extend `getBestAccessPlan` to advertise secondary-index access paths and
  `query()` to execute them, keeping the store's "handled" filters honest (an
  index seek that under-fetches is the same silent-wrong-results hazard as the
  PK key-encoding bugs — the derived window must be a guaranteed superset with
  an authoritative row filter, exactly as the completed `store-pk-range-seek`
  work established for PK ranges).

Open questions to settle before emitting implement ticket(s): index-entry
payload layout (store base PK vs. store full row), read-your-own-writes over
pending index mutations within a transaction, collation handling on indexed
text columns (align with `store-range-seek-collation-bounds` /
`store-index-derived-unique-honors-index-collation`, already complete), and
DESC/composite-index window derivation. Consider splitting into prereq-chained
implement tickets: (a) index scan read primitive + access-plan surface, then
(b) UNIQUE-check rewrite on top of it.

## Edge cases & interactions

- Read-your-own-writes: index seek within an open transaction must see pending
  index puts/deletes, not just committed entries (mirror `iterateEffective`).
- Collation: an indexed TEXT column with NOCASE/RTRIM must seek under the index
  key collation while the authoritative row filter compares under the column
  collation (no under-fetch).
- Composite / DESC indexes: bound derivation must match `encodeCompositeKey`
  direction handling.
- UNIQUE across NULLs: SQL NULLs do not collide — the point lookup must not
  treat two NULL index keys as a violation.
- Interaction with the PK key-encoding fixes (numeric/blob sort order): the
  index scan reuses the same encoder, so it inherits those fixes.
