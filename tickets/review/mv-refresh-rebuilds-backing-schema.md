description: Review the shape-aware `refresh materialized view` implementation — refresh now re-derives the backing table's shape and rebuilds the backing table (drop+recreate+fill) when a source `alter` has shifted the re-planned body's output shape, instead of swapping new rows into the stale create-time schema. This repairs the latent direct-read corruption for schema-shifting (`select *`) bodies and restores positional backing↔body alignment, which re-enables the join read-rewrite.
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/materialized-view-refresh-reshape.spec.ts, packages/quereus/test/query-rewrite-join.spec.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md, docs/optimizer.md
----

## What was implemented

`refresh materialized view` is now **shape-aware**. Before, `emitRefreshMaterializedView`
→ `rebuildBacking` only re-ran the body and `replaceBaseLayer`'d the rows into the
*existing* backing `TableSchema`. For a schema-shifting body (the canonical case: a
`select *` join MV after `alter table <src> add column`), the re-planned body interleaves
the new column while the backing did not reorder — so the new rows were stuffed into the
stale column labels, silently surfacing values under the wrong labels (a direct-read
corruption) and breaking the positional `mvStoredJoinColumns` map the join read-rewrite
relies on (the review of the originating ticket added `backingAlignsWithBody` to *forgo*
the rewrite on the mismatch — correct but unoptimized).

### Code

- **`materialized-view-helpers.ts`**
  - Exported `computeBackingPrimaryKey` (was private) so the physical-PK compare uses the
    same key the rebuild installs.
  - Added `backingShapeMatches(current: TableSchema, shape: BackingShape)` — true iff the
    derived shape would build a structurally identical backing: column count; per-column
    name (case-insensitive), logical type, not-null, collation; and the physical PK
    (`computeBackingPrimaryKey(shape)` vs `current.primaryKeyDefinition`, index+desc+
    collation in order).
  - Added `rebuildBackingTable(db, mv, shape)` — drop+recreate+fill mirroring the create
    path (`buildBackingTableSchema` → `createBackingTable` → `replaceBaseLayer`). Collects
    body rows **before** dropping the old backing (minimizing the no-backing window). On a
    fill failure (e.g. a duplicate-producing reshape) drops the half-built backing so the
    next read errors rather than serving an empty relation.
- **`materialized-view.ts` `emitRefreshMaterializedView`**
  - Re-derive `shape = deriveBackingShape(db, bodySql, mv.columns)`.
  - **Explicit-column count-shift → error**: if `mv.columns` is set and its length differs
    from the re-derived body output count, throw a "declared with N columns but its body
    now produces M after a source change — drop and recreate" diagnostic (the declared
    column list is an interface; do not silently widen it). MV stays stale.
  - **Conditional**: `backingShapeMatches` → fast path (`rebuildBacking`, data-only,
    backing identity + caches preserved); else `rebuildBackingTable` and update
    `mv.primaryKey`/`ordering`/`sourceTables` to the new shape.
  - Order preserved: (re)build → `registerMaterializedView` (binds maintenance to the new
    backing) → clear `stale` → notify.
- `backingAlignsWithBody` and `cachedBodyRootIsCurrent` left **unchanged** (defense-in-depth);
  the provenance/name-keyed map from the originating ticket's candidate list was **not**
  implemented (unnecessary once the backing is rebuilt).

### Docs

- `docs/materialized-views.md` § REFRESH: documented the shape-aware fast-path-vs-rebuild
  behavior and the explicit-column count-shift error.
- `docs/optimizer.md` § Materialized-view query rewrite (read side): the join-arm text now
  says the rewrite **re-enables** after a schema-shifting refresh (alignment restored by the
  rebuild) and `backingAlignsWithBody` remains defense-in-depth.

## Use cases / validation (the testing floor — treat as a starting point)

All green: `yarn test` (4893 passing, 9 pending), `yarn lint` clean, `yarn typecheck`
clean. Spot-ran `51-materialized-views.sqllogic` under `yarn test:store` (LevelDB) — green
(exercises the ALTER store code path).

Tests added/updated:
- `materialized-view-refresh-reshape.spec.ts` (new):
  - **Direct-read corruption regression** — `select *` join MV, `alter add column default`,
    `refresh`, then `select * from v` returns the correct 6-col shape with values under the
    right labels (pre-fix this returned `extra` under `id:1`, `c.id` under `name`,
    `c.name` under a fabricated `col_5` — confirmed by a throwaway repro before the fix).
  - **Non-`*` interleave** — `select o.*, c.name` body gaining an `orders` column rebuilds.
  - **Fast-path identity** — refresh with no source change returns the *same* backing
    `TableSchema` object (guards against an unconditional-rebuild regression).
  - **Explicit-column count-shift → clear error**.
  - **Row-time after reshape** — a source insert after the reshape propagates the new column.
- `query-rewrite-join.spec.ts`: the former "forgoes after desync" test (`jstar`) is updated
  to assert the rewrite **re-enables** after `alter`+`refresh` (rebuild realigned the
  backing) and a direct read exposes the interleaved column.
- `51-materialized-views.sqllogic`: §9 alter+refresh+`select *` correctness + row-time;
  §10 explicit-column count-shift error.

## Known gaps / risks for the reviewer

1. **Explicit-transaction `alter`+`refresh` of a `select *` MV is wrong (PRE-EXISTING,
   out of scope — fix ticket filed).** When the whole sequence runs inside an explicit
   `begin … commit` (rather than autocommit), refresh fills the rebuilt backing with **stale
   data**: the new column reads as a misaligned value (e.g. `extra` shows `1`). Investigated
   thoroughly (throwaway probes): the schema *catalog* is correctly updated mid-txn (4 cols)
   and `db.getPlan` derives the correct 6-col shape, but the *execution* of the body via the
   prepared/suppressed scan path resolves the MV's **source table** (`orders`) to its
   **pre-alter row shape** — a raw `select * from orders` mid-txn with the MV present returns
   only 3 columns, while the identical read with **no MV present returns 4 (correct)**. The
   wrong rows come from `collectBodyRows`, a function shared with the old fast-path
   `rebuildBacking` and **unchanged** by this ticket, so this is not a regression introduced
   here — it is a pre-existing in-transaction-DDL + MV-source-read data-visibility bug.
   The **autocommit path** (the normal way refresh/alter are issued, and the only form in
   every existing MV test) is **fully correct**. Filed as
   `tickets/fix/mv-refresh-intxn-altered-source-stale-read.md`. The ticket's suggested
   in-place `rebuildMemoryTable` fallback would **not** help (same `collectBodyRows` read).
   *Reviewer: confirm you agree this is pre-existing/out-of-scope, or escalate.*

2. **Reshape that changes the derived PK / becomes duplicate-producing — failure path not
   directly tested.** A realistic source column *add* preserves the PK and the set property,
   so I could not construct a non-artificial reshape that shifts the PK or makes the body a
   bag. The failure handling exists (`rebuildBackingTable` drops the half-built backing on
   `replaceBaseLayer` throw, leaving the MV stale → next read errors), but there is no test
   exercising it. If the reviewer can construct such a case it's worth a test.

3. **MV-over-MV cascade on a producer reshape — relied on, not explicitly tested here.** The
   rebuild's `table_removed`/`table_added` on `_mv_<name>` cascades staleness to a consumer
   MV via the manager's existing source-tracking listener (the same machinery covered by
   `materialized-view-plan.spec.ts`'s cascade test). The acyclic-DAG termination argument is
   the existing one; a focused producer-reshape→consumer-stale test would harden it.

4. **Cached-prepared-plan invalidation on rebuild** relies on the drop/create firing
   `table_removed`/`table_added` for `_mv_<name>` (the Statement dependency listener matches
   `table` events). Verified indirectly (the direct-read regression returns the new shape via
   re-planning), but not via a dedicated cached-`Statement` test like
   `materialized-view-plan.spec.ts` uses; a focused one would be stronger.
