description: A plain UNIQUE column in the persistent store has no index behind it, so checking it still scans the whole table and bulk inserts stay slow; give every UNIQUE constraint its own on-disk index so the check becomes a fast lookup like it already is for explicitly-indexed columns.
files:
  - packages/quereus-store/src/common/store-module.ts   # createIndex / buildIndexEntries / rebuildSecondaryIndexes / table create + reopen
  - packages/quereus-store/src/common/store-table.ts     # updateSecondaryIndexes iterates schema.indexes; UNIQUE enforcement
  - packages/quereus/src/schema/table.ts                 # UniqueConstraintSchema, exposedIndexTags (store does NOT materialize implicit indexes today)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # ensureUniqueConstraintIndexes — memory's implicit `_uc_*` synthesis, the reference behavior
----

# Store: materialize an implicit index for every UNIQUE constraint

## What this is about

In the persistent store, an explicit `create index` / `create unique index`
produces a real on-disk index. A plain `UNIQUE` declared on a column or table
(e.g. `email text unique`) does **not** — the store keeps the constraint but
builds no index for it. As a result, enforcing that constraint means scanning the
whole table for every inserted row, and a bulk load of *n* rows costs about *n²*
work.

The memory backend already solves this: it synthesizes a hidden `_uc_*` index for
each UNIQUE constraint and enforces through it. The store deliberately does not
(see the `exposedIndexTags` note in `schema/table.ts`). This ticket is to bring the
store to parity: give every UNIQUE constraint a physical index the enforcement path
can point-look-up, so plain `UNIQUE` gets the same speed-up that indexed columns
get from the `store-unique-check-via-index` work.

## Why it is filed separately (not folded into the index-read work)

The sibling tickets `store-index-scan-read-primitive` and
`store-unique-check-via-index` add the ability to *read* an index and route the
UNIQUE check through one **when an index already exists**. They do not create
indexes for constraints that lack one. Doing that is a distinct feature with its
own design surface and failure modes, which is why it needs its own planning pass
rather than being bolted on:

- **Lifecycle.** Build + populate an index on `create table` and on
  `add constraint unique`; tear it down on `drop`; rebuild on
  `alter column ... set collate` and `alter primary key` (the PK suffix in the
  index key changes), matching how explicit indexes are already rebuilt
  (`rebuildSecondaryIndexes`).
- **Where the index list lives.** Today `updateSecondaryIndexes` iterates
  `schema.indexes`, which for the store holds only explicit indexes. Either the
  store starts materializing `_uc_*` entries into `schema.indexes` (changes what
  the engine/catalog sees, and interacts with implicit-index exposure via
  `quereus.expose_implicit_index` / `exposedIndexTags`), or it maintains a
  store-internal derived list keyed off `uniqueConstraints`. Pick one — this is
  the main design decision.
- **Persistence vs. derive-on-open.** The `_uc_*` index is fully derivable from
  `uniqueConstraints`, so it may not need its own catalog entry — it can be
  (re)built on reopen. But that trades reopen cost for catalog simplicity; decide
  deliberately and align with how `buildIndexEntries` / catalog bundles work.
- **Collation.** The implicit index must enforce under the constraint's declared
  per-column collation, consistent with `uniqueEnforcementCollations` and the
  collation guard the sibling ticket documents (the physical index-column bytes are
  encoded under the table key collation K, which must be coarser-or-equal to the
  enforcement collation for a point seek to be a safe superset).
- **Interaction with existing indexes.** When an explicit index already covers a
  UC's columns with compatible collation, reuse it instead of building a duplicate
  `_uc_*` index — mirror memory's reuse logic in `ensureUniqueConstraintIndexes`.

## Expected outcome

- A plain `create table t (id integer primary key, email text unique)` in the
  store gains a physical index behind `email`, and a bulk insert of many rows
  completes in roughly O(n log n) instead of O(n²).
- Enforcement for plain UNIQUE routes through the same index point-lookup the
  sibling ticket added for explicitly-indexed UNIQUE — no separate enforcement
  code path.
- Reopen, `alter`, and `drop` keep the implicit index consistent with the data.
- Behavior matches the memory backend for the same DDL (same conflicts raised,
  same NULL/partial/collation semantics).

## Prerequisite

Depends on `store-index-scan-read-primitive` and `store-unique-check-via-index`
landing first (the read arm and the index-backed enforcement path this feature
feeds new indexes into). When promoted from backlog, chain it after those via
`prereq:`.
