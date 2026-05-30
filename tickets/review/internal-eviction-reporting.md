description: Review the new `UpdateResult.evictedRows` channel that surfaces internal secondary-UNIQUE REPLACE evictions to the DML executor, so the one post-write pipeline (change-tracking, row-time MV maintenance, FK ON DELETE actions, auto-events) runs for them uniformly across memory / store / isolation. Resolves `covering-mv-isolation-layer-enforcement-routing`.
prereq:
files: packages/quereus/src/common/types.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic, packages/quereus/test/covering-structure.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md, docs/module-authoring.md, docs/runtime.md
----

## What landed

A REPLACE conflict has two physical shapes. **PK-collision REPLACE** (new row lands on
an occupied PK, displaced row at the *same* PK) was already surfaced via
`UpdateResult.replacedRow`. **Secondary-UNIQUE REPLACE eviction** (new row satisfies the
PK but collides on a *non-PK* UNIQUE with a row at a *different* PK) was deleted invisibly
inside `vtab.update()` and never reported — so FK ON DELETE cascade/set-null,
`Database.watch`/change-scope, and auto-events never fired for the evictee, and only the
covering-MV detection path patched the backing (by hand-pasted maintenance, in two of the
three substrates).

This adds an additive, optional `evictedRows?: readonly Row[]` to the `ok` branch of
`UpdateResult`. Each substrate now **only detects + deletes** the evicted source row and
reports it; the DML executor runs the **same full delete pipeline** it runs for an ordinary
delete, once, in one place.

### Change map
- **`common/types.ts`** — `evictedRows` added to the `ok` union arm and the `isUpdateOk`
  guard; the `replacedRow` vs `evictedRows` contract documented at the type.
- **`dml-executor.ts`** — new nested `processEvictions(ctx, needsAutoEvents, tableKey,
  evictedRows, cache)` helper drives `_recordDelete` + `maintainRowTimeStructures({op:'delete'})`
  + `executeForeignKeyActions('delete')` + delete auto-event per evicted row. Called in
  `processInsertRow` and `processUpdateRow` **before** the writing row's own bookkeeping
  (after any `replacedRow` handling) — evict-then-write order.
- **memory `manager.ts`** — a `Row[]` accumulator threaded through `checkUniqueConstraints`
  → `checkSingleUniqueConstraint` → `checkUniqueVia{Index,MaterializedView,Scanning}`; each
  REPLACE branch pushes the evicted row. The inline `_maintainRowTimeCoveringStructures`
  call in `checkUniqueViaMaterializedView` is **removed** (now flows through the executor).
  `performInsert` / `performUpdate` / `performUpdateWithPrimaryKeyChange` return `evictedRows`.
- **store `store-table.ts`** — same accumulator through `checkUniqueConstraints`; REPLACE
  pushes `conflict.row` and drops the inline `_maintainRowTimeCoveringStructures` call;
  insert/update results include `evictedRows`.
- **isolation `isolated-table.ts`** — `checkMergedUniqueConstraints` collects the evicted
  underlying row; `update()` surfaces it via a new `attachEvicted` helper (tombstone column
  stripped, merges with any already present). **Critically**, `stripTombstoneFromResult`
  now also propagates the overlay's OWN `evictedRows` — an intra-statement secondary-UNIQUE
  REPLACE against a row written earlier in the *same statement* lives in the overlay (not
  the underlying), so the overlay's memory module evicts it and the isolation layer's own
  merged-view detection never sees it. (This was a real bug caught by `yarn test:store`
  §9 before the fix — see "Watch points" below.)
- **docs** — `materialized-views.md` (eviction-maintenance edge + store-module parity +
  roadmap, noting `covering-mv-isolation-layer-enforcement-routing` is resolved),
  `module-authoring.md` (new "Update results and REPLACE displacement" section), and
  `runtime.md` (new "Per-row post-write pipeline and internal evictions" subsection).

## Use cases to validate

The eviction must be a **secondary-UNIQUE REPLACE** to exercise this: a new/updated row
collides on a *non-PK* UNIQUE with an existing row at a *different* PK, under REPLACE
(`insert or replace`, or a UPDATE governed by a `unique(...) on conflict replace` default).

1. **FK ON DELETE CASCADE / SET NULL fires for the evictee's children** — the headline fix.
   `insert or replace into p values (2,'a@x')` over `p(unique(email))` with `p(1,'a@x')` and
   a child FK→p(id) ON DELETE CASCADE must delete the child. SET NULL must null it (the FK
   column must be declared `null` — Quereus columns are NOT NULL by default).
2. **`Database.watch` / change-scope delta** for the evicted PK (driven by the new
   executor `_recordDelete`).
3. **Delete data-change event** for the evicted row (native emitter for memory/store-with-emitter;
   executor auto-event for non-native modules, e.g. the direct store in unit tests).
4. **Covering-MV backing consistency** — `select <uc>,<pk> from mv` after the eviction shows
   only the surviving row, on memory, direct store, AND isolation-wrapped store alike.
5. **Non-covered variant** (plain UNIQUE auto-index/scan, no MV) — proves the FK/event fix
   independently of the covering-MV path.
6. **Intra-statement eviction** — `insert or replace into t values (1,7,7),(2,7,7)`: row 2
   evicts row 1 written earlier in the same statement; backing nets to one row.

### Tests added/changed (the floor, not the ceiling)
- `54-covering-mv-enforcement.sqllogic` — NOTE caveat at §1 deleted; backing `select from mv`
  assertions promoted for the internal-eviction cases (§1 `ix`, §3 `ur_ix`, §9 `rr_ix`) — now
  pass on memory + store + isolation.
- `55-internal-eviction-reporting.sqllogic` (new) — FK ON DELETE CASCADE / SET NULL on the
  evictee's children, non-covered + covered + UPDATE-with-REPLACE-default variants. Runs
  under `yarn test` (memory) and `yarn test:store` (isolation-over-store).
- `covering-structure.spec.ts` — new `describe('internal-eviction reporting …')`: FK cascade,
  FK set-null, change-scope watch delta + delete event, covered-MV backing (memory).
- `unique-constraints.spec.ts` — new `describe`: FK cascade + watch-delta + delete-event on
  the **direct** store module (no isolation overlay).

### Validation run (all green)
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (memory): 4068 passing. `yarn test:store`: 4064 passing.
- store pkg 276, isolation pkg 68, leveldb plugin 12 passing; engine/isolation/store/leveldb/
  indexeddb builds clean.

## Watch points for the reviewer (treat tests as a floor)

- **isolation `stripTombstoneFromResult` propagation + `attachEvicted` merge** — the
  intra-statement case (overlay-internal eviction) only works because `stripTombstoneFromResult`
  now forwards the overlay's `evictedRows`. The two eviction sources (overlay vs underlying)
  are argued disjoint per write (the conflicting row lives in the overlay XOR the underlying,
  because `checkMergedUniqueConstraints` tombstones underlying conflicts *before* `overlay.update`
  runs); `attachEvicted` merges rather than overwrites as a safety margin. Worth an adversarial
  read of that disjointness claim and the eviction ordering.
- **`replacedRow` + `evictedRows` co-occurrence is untested** — by design they cannot co-occur
  in the current memory/store/isolation substrates (INSERT short-circuits on a PK collision
  *before* the secondary-UNIQUE check; the UPDATE move path returns `replacedRow` without
  running the UC check). The executor handles both fields cleanly, but there is no test that
  forces both at once because no substrate can produce it. The underlying INSERT short-circuit
  is a separate latent gap vs SQLite, explicitly out of scope here.
- **Multiple evictions in one `update()`** (e.g. a partial-UNIQUE with several conflicting
  rows) accumulate into the array and the executor loops them; covered only incidentally, not
  by a dedicated multi-evictee assertion.
- **LevelDB / IndexedDB plugins** inherit `StoreTable.update`, so they now report evictions
  (FK/events/backing fire for plugin secondary-UNIQUE REPLACE) with no plugin code change.
  Build-verified + leveldb unit tests pass, but no plugin test specifically asserts the new
  eviction cross-cuts.
- **Data-event (c) was partly pre-existing for memory** — the memory transaction layer already
  recorded the eviction delete in its change-tracking (emitted on commit). The genuinely-new
  effects everywhere are the executor's `_recordDelete` (watch/change-scope) and FK actions;
  the auto-event is new only for non-native modules (e.g. the direct store with no emitter).
- **Pre-existing, out of scope**: the non-binary-collation covering-MV enforcement soundness
  gap (`unique-constraint-honors-column-collation`) is unchanged.
