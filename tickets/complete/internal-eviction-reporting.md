description: Surface internal secondary-UNIQUE REPLACE evictions to the DML executor via `UpdateResult.evictedRows`, so the single post-write pipeline (change-tracking, row-time MV maintenance, FK ON DELETE actions, auto-events) runs for them uniformly across memory / store / isolation. Resolves `covering-mv-isolation-layer-enforcement-routing`.
prereq:
files: packages/quereus/src/common/types.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic, packages/quereus/test/covering-structure.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md, docs/module-authoring.md, docs/runtime.md
----

## What landed

An additive, optional `evictedRows?: readonly Row[]` on the `ok` branch of `UpdateResult`.
Each substrate now only **detects + deletes** the secondary-UNIQUE REPLACE evictee and
**reports** it; the DML executor runs the **same full delete pipeline** it runs for an
ordinary delete, once, via a shared `processEvictions` helper. The inline
`_maintainRowTimeCoveringStructures` hacks in the memory and store substrates were removed
(maintenance now flows through the one executor pipeline — DRY). Resolves
`covering-mv-isolation-layer-enforcement-routing`: isolation gets covering-MV backing
consistency structurally rather than by re-pasting detection.

See the implement-stage commit `d54d3519` for the full change map.

## Review findings

Reviewed the implement diff with fresh eyes from SPP / DRY / modularity / type-safety /
resource-cleanup / error-handling / correctness angles, re-derived the canonical delete
pipeline (`processDeleteRow`) to compare `processEvictions` against, audited every changed
file plus the docs, ran lint and targeted suites, and adversarially probed the two
watch-points the handoff flagged.

### Verified correct
- **`processEvictions` matches the canonical delete bookkeeping** (`_recordDelete` +
  `maintainRowTimeStructures({op:'delete'})` + `executeForeignKeyActions('delete')` +
  conditional auto-event), looped per evicted row, evict-before-write — equivalent to
  `processDeleteRow`'s body.
- **Isolation disjointness (overlay-internal vs underlying eviction sources).**
  `findMergedUniqueConflict` scans only the underlying and skips overlay-tombstoned PKs,
  so overlay-internal evictions are caught solely by the overlay memory module and
  forwarded via `stripTombstoneFromResult`; underlying evictions are caught solely by the
  isolation layer. `attachReplacedUnderlying` was correctly changed from a fresh-object
  build to a `{...result}` spread so it no longer drops a co-present `evictedRows`;
  `attachEvicted` merges rather than overwrites. The intra-statement eviction path holds.
- **No broken callers.** `checkUniqueConstraints` gained a required `evicted` param across
  memory/store/isolation; all internal callers updated, no plugin overrides it
  (leveldb/indexeddb inherit `StoreTable.update`, not the check).
- **No double-counting for memory.** The executor's `_recordDelete`/watch is new; the
  native data-change event for the eviction was already emitted by the memory layer, and
  `needsAutoEvents` is false for native-event modules, so no duplicate event.
- **Tests pass.** `yarn workspace @quereus/quereus run lint` clean. Targeted memory suite
  (`covering enforcement` + `internal-eviction reporting` + `54`/`55` sqllogic) 24
  passing; store-mode `54`/`55` sqllogic 2 passing; store-pkg eviction spec 2 passing.
  No source files were changed during review (only docs + new tickets), so the
  implementer's full-suite run (`yarn test` 4068, `yarn test:store` 4064) still holds.

### Minor — fixed in this pass
- **Docs omitted the RESTRICT limitation.** `module-authoring.md` listed FK actions as
  "CASCADE / SET NULL / …", glossing over the fact that `RESTRICT` / `NO ACTION` is NOT
  enforced for evictions. Added explicit known-limitation notes to `docs/module-authoring.md`
  and `docs/runtime.md` pointing at the new `eviction-restrict-fk-enforcement` ticket.

### Major — filed as new fix tickets (out of scope to fix inline)
- **`eviction-restrict-fk-enforcement`** — `processEvictions` fires FK *actions*
  (CASCADE/SET NULL/SET DEFAULT) but never runs the `RESTRICT`/`NO ACTION` pre-check that
  `processDeleteRow` runs (`assertNoRestrictedChildrenForParentMutation`). An
  `INSERT OR REPLACE` that evicts a row referenced by a RESTRICT (or default NO ACTION)
  child proceeds silently and orphans the child, where SQLite fails the statement.
  **Confirmed by probe** (`on delete restrict` child not deleted, no error). The FK default
  `onDelete` is `'restrict'`, so this affects every FK lacking an explicit cascade clause.
  Architectural (the substrate deletes-then-reports, so there is no pre-mutation point) —
  not an inline fix. Pre-existing for evictions (they fired no FK enforcement at all
  before), but newly relevant now that the other FK actions DO fire.
- **`isolation-replace-pk-and-unique-cooccurrence`** — the handoff's watch-point claim
  that `replacedRow` and `evictedRows` "cannot co-occur in any substrate" is **false for
  isolation**: its insert path runs both the PK-collision check and the secondary-UNIQUE
  check without short-circuiting. When both fire in one `INSERT OR REPLACE`, the new row's
  non-PK values are **lost** — the colliding PK reverts to the old underlying values
  (`insert or replace into b values (5,'dup')` over `b(5,'old'),b(9,'dup')` yields
  `[{5,'old'}]` instead of `[{5,'dup'}]`). **Confirmed pre-existing** (reproduces on the
  parent commit `d29d90d2`); this ticket neither caused nor worsened the stored-data
  outcome, but the co-occurrence path is real, reachable, and untested. Filed as a
  separate isolation-merge correctness bug.

### Checked, empty
- **Resource cleanup / leaks** — none; the `evicted: Row[]` accumulators are local and GC'd.
- **Error handling** — eviction FK cascades propagate exceptions up the row loop as any
  delete would; nothing is swallowed.
- **Type safety** — `evictedRows?: readonly Row[]` threaded cleanly; `isUpdateOk` guard
  updated; no `any` introduced.
