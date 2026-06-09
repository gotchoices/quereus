description: COMPLETE — RENAME-driven plain-view body rewrites now fire `view_modified` from both rename-propagation loops (table rename + column rename), so a store-backed catalog re-persists the rewritten view DDL instead of letting it drift. Reviewed: implementation correct + symmetric; cache/store/MV wiring verified by code inspection; engine suite + lint + build green. Review added the deferred end-to-end store round-trip spec (and the harness `renameTableStores` it needed), proving rename → re-persist → reopen keeps the view's DDL pointed at the new name AND queryable. Full store suite green (385 passing); engine suite green (5411 passing).
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          # propagateTableRenameInSchema (~L1322) + propagateColumnRenameInSchema (~L1420) — view loops fire view_modified
  - packages/quereus/src/schema/change-events.ts              # ViewModifiedEvent doc comment (two sources)
  - packages/quereus/src/core/statement.ts                    # ~L160 maps view_modified → 'view' dependency (plan-cache invalidation)
  - docs/schema.md                                            # view_modified event-table row (~L438)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts     # engine-side: +4 specs (table/column rename, unrelated-view, two-views)
  - packages/quereus-store/test/view-mv-persistence.spec.ts   # REVIEW ADDED: +2 end-to-end store round-trip specs + renameTableStores on the persistent provider
  - packages/quereus-store/src/common/store-module.ts         # onEngineSchemaChange routes view_added/view_modified → saveViewDDL (~L1868); unchanged
----

# Fire `view_modified` when a RENAME rewrites a plain view body

## What shipped

`ALTER TABLE t RENAME TO t2` and `ALTER TABLE t RENAME COLUMN a TO b` propagate the rename into
every dependent plain view in the renamed object's own schema, mutating each view's `selectAst`
in place and re-registering it via `schema.addView`. Both propagation helpers now fire
`view_modified` after re-registering each rewritten view (the sibling table loop already fired
`table_modified`). A store-backed catalog persists views from `view_added`/`view_modified`, so
without this event the rewritten view DDL silently drifted after a rename — the stored body kept
the OLD table/column name and failed to rehydrate.

The existing `view_modified` event was reused (not a new type). The store consumer
(`store-module.ts` `onEngineSchemaChange`) already routes both `view_added` and `view_modified`
through `saveViewDDL(view)` → compare-write, so a body rewrite re-persists with zero new wiring.

Event payload: `objectName: updatedView.name` (the view's own name is unchanged by the rename),
`oldObject: view`, `newObject: updatedView`. `newObject.sql` carries the re-generated,
re-persistable DDL referencing the new name.

## Review findings

Adversarial pass over commit `43505ac7`. Scrutinized correctness, symmetry, DRY, the
shared-mutated-AST hazard, event consumers, cache invalidation, docs, and test coverage.

### Checked — clean (no action)

- **Symmetry.** Both propagation helpers (`propagateTableRenameInSchema`,
  `propagateColumnRenameInSchema`) fire `view_modified` identically and only inside the
  `schema.name === renamedSchemaLower` guard, only when `changed` (the AST rewriter reports a
  hit). One event per actually-rewritten view — verified by the engine specs (unrelated view →
  zero events; two views → two events).
- **Shared-mutated-AST `oldObject` (the flagged hazard).** `renameTableInAst`/
  `renameColumnInAst` mutate `view.selectAst` in place, so `oldObject.selectAst` already points
  at the rewritten AST when the event is built (only `newObject.sql` differs). I grepped every
  `view_modified` consumer: **`store-module.ts` reads only `event.newObject`** (`saveViewDDL`);
  **`statement.ts` (~L160)** maps `view_modified` → a `'view'` dependency and matches by
  `objectName`/`schemaName` only — neither dereferences `oldObject`'s body/sql. The hazard is
  inert, and a code comment flags it in both loops. Matches the adjacent table loop's existing
  in-place-mutate-then-fire pattern.
- **No spurious MV rebuild.** `MaterializedViewManager.subscribeToSchemaChanges`
  (`database-materialized-views.ts`) gates staleness on `table_removed`/`table_modified` only —
  `view_modified` is ignored, so it cannot trigger an MV rebuild. Likewise `AssertionEvaluator`
  and `WatcherManager` listen on `table_*` only.
- **Cache invalidation is strictly additive.** `statement.ts` now invalidates a cached plan
  carrying a `view` dependency on this event (previously: no event → no invalidation). A plain
  `select … from v` inlines the body onto the underlying table and is already invalidated by the
  rename's own `table_modified`. Worst case is a redundant recompile — never less correct.
- **Docs.** `change-events.ts` `ViewModifiedEvent` doc comment lists both sources (SET TAGS +
  RENAME body-rewrite); `docs/schema.md` event-table row (~L438) updated to match. Both accurate
  against the shipped code.
- **DRY (observed, deliberately not churned).** The 7-line `view_modified` notify block is
  duplicated across the two helpers — but so is the adjacent `table_modified` notify block, and
  the helpers are intentional structural twins (paralleling `rewriteTableForTableRename` /
  `rewriteTableForColumnRename`). Extracting only the view notify would diverge from the file's
  established inline-notify idiom. Left as-is per "read like the surrounding code."

### Found + fixed in this pass (minor)

- **Deferred end-to-end store round-trip — ADDED.** The implementer deferred the store-package
  round-trip spec, leaving the ticket's load-bearing fact (a store catalog re-persists the
  rewritten DDL across reopen) proven only at the event layer, never through the real
  persist→reopen chain. Added two specs to `packages/quereus-store/test/view-mv-persistence.spec.ts`:
  - **table rename** — create table+view, `rename to base2`, `closeAll`, reopen → clean
    rehydrate, view registered, `view.sql` matches `/\bbase2\b/`, and `select … from v` returns
    the correct rows (queryable only if the body resolves to `base2`).
  - **column rename** — analogous, asserting the rewritten DDL + a query under the new column
    name.
  Writing these surfaced that the spec's `createPersistentProvider()` lacked `renameTableStores`,
  so a renamed table's data orphaned under the old key and the query returned `[]` (a **harness**
  limitation — the engine fix itself was already proven by the DDL/rehydrate assertions that
  passed). Added `renameTableStores` to the provider, mirroring the established implementation in
  `alter-table.spec.ts` (relocates the data + index stores; stats recompute). With it, both
  round-trips pass green end-to-end. These are pure additions — no product code changed.

### Major findings filed as new tickets

None. The two known limitations are both intentional and already tracked:

- **Materialized views over a renamed source** are not rewritten/marked stale — out of scope by
  design; tracked in `tickets/backlog/mv-body-not-rewritten-on-source-rename.md` (verified
  present).
- **Cross-schema views** referencing the renamed table are not rewritten — pre-existing scoping
  (the view loop only runs for views in the renamed object's own schema); unchanged by this
  ticket.

### Validation run

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn lint` (packages/quereus) → exit 0
- Engine suite `node packages/quereus/test-runner.mjs` → **5411 passing, 9 pending, exit 0**
  (the `[property-planner] Rule '…' never fired` lines are pre-existing informational notices,
  not failures).
- Full store-package suite `yarn workspace @quereus/quereus-store test` → **385 passing, exit 0**
  (includes the 2 new round-trips; the `boom` / `THIS IS NOT VALID SQL` / `memsrc` console lines
  are deliberate negative-test output).
- The slow `yarn test:store` LevelDB logic suite was **not** run (engine/in-memory store paths
  fully exercised; the store consumer code is unchanged). No pre-existing failures observed; no
  `.pre-existing-error.md` filed.
