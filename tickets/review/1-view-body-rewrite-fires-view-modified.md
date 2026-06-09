description: REVIEW — RENAME-driven plain-view body rewrites now fire `view_modified` from both rename-propagation loops (table rename + column rename), so a store-backed catalog re-persists the rewritten view DDL instead of letting it drift. Event reused (not a new type); store consumer already routed `view_modified` → `saveViewDDL`, so no store change. Build + full suite green (5411 passing).
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          # propagateTableRenameInSchema (~L1322) + propagateColumnRenameInSchema (~L1410) — view loops now notifyChange('view_modified')
  - packages/quereus/src/schema/change-events.ts              # ViewModifiedEvent doc comment revised (no longer SET-TAGS-only)
  - docs/schema.md                                            # view_modified event-table row (~L438) updated
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts     # +4 specs: table/column rename, unrelated-view, two-views
  - packages/quereus-store/src/common/store-module.ts         # READ-ONLY — onEngineSchemaChange already routes view_modified → saveViewDDL (~L1868); unchanged
----

# Review: fire `view_modified` when a RENAME rewrites a plain view body

## What changed (the fix)

`ALTER TABLE t RENAME TO t2` and `ALTER TABLE t RENAME COLUMN a TO b` propagate the rename
into every dependent plain view in the renamed object's own schema, mutating each view's
`selectAst` in place and re-registering it via `schema.addView`. Both propagation helpers
previously fired **no** schema-change event from their view loop (the sibling table loop fires
`table_modified`). A store-backed catalog persists views from `view_added`/`view_modified`, so
the rewritten view DDL silently drifted after a rename.

Fix: both view loops now call `notifier.notifyChange({ type: 'view_modified', … })` after
`schema.addView(updatedView)`, with `objectName: updatedView.name` (the view's own name is
unchanged by the rename), `oldObject: view`, `newObject: updatedView`.

- `propagateTableRenameInSchema` — alter-table.ts ~L1322-1338
- `propagateColumnRenameInSchema` — alter-table.ts ~L1410-1426

Reused the existing `view_modified` event rather than adding a new type. Verified in-tree:
the store consumer (`store-module.ts` `onEngineSchemaChange`) already falls `view_added` AND
`view_modified` through to `saveViewDDL(view)` → `persistObjectCatalogEntryIfChanged` (compare-
write), so a body rewrite re-persists with zero new wiring. No store change in this diff.

Doc updates: `ViewModifiedEvent` doc comment in `change-events.ts` no longer says "SET-TAGS-
only" (now lists both sources); `docs/schema.md` event-table row for `view_modified` mentions
the RENAME body-rewrite source.

## How to validate

Build + targeted + full suite all run clean on this machine:

- `yarn workspace @quereus/quereus run build` → exit 0
- New specs (grep): `node packages/quereus/test-runner.mjs --grep "RENAME rewrites a view body"`
  → 4 passing
- Full engine suite: `node packages/quereus/test-runner.mjs` → **5411 passing, 9 pending,
  exit 0** (includes `view-tag-mutation-plan.spec.ts` and `test/logic/41.3-alter-rename-
  propagation.sqllogic` — no regression).
  - Note: the run prints `[property-planner] Rule '…' never fired across 30 runs` lines — these
    are pre-existing informational property-planner notices, **not** failures (exit 0).

### Key behaviors the new specs pin (in `view-mv-ddl-persistence.spec.ts`)

Reuse the file's `captureEvents(db, fn)` helper + `generateViewDDL` import; a local
`viewModifiedFor(events, name)` narrows the stream to `view_modified` for one view name.

1. **table rename → one `view_modified` for the dependent view**, `schemaName === 'main'`,
   and `generateViewDDL(newObject)` matches `\bt2\b` and not `\bfrom\s+t\b` (DDL re-persistable
   against the new name).
2. **column rename → one `view_modified`**, `generateViewDDL(newObject)` matches `\bident\b`.
3. **unrelated view** (`w as select 1 as a`, body does not name `t`) fires **no**
   `view_modified` — `changed === false` ⇒ no `schema.addView`, no event.
4. **two dependent views → two events** (one per rewritten view), each DDL rewritten.

## Adversarial angles for the reviewer

- **Shared-mutated-AST `oldObject` (intended, commented).** `renameTableInAst` /
  `renameColumnInAst` mutate `view.selectAst` **in place**, so `oldObject.selectAst` already
  points at the *rewritten* AST by the time the event is built — only `newObject.sql` differs.
  This mirrors the adjacent table loop (`rewriteTableForTableRename` mutates `cc.expr` in place
  before firing `oldObject: table`). A one-line code comment flags it in both view loops. The
  load-bearing claim is "no consumer reads `oldObject.selectAst`/`oldObject.sql` for views" —
  store reads `newObject`, plan cache matches by name. **Worth a reviewer double-check**: grep
  for any `view_modified` listener that dereferences `oldObject`'s body/sql. I confirmed only
  `store-module.ts` consumes view events and it reads `newObject`; the MV maintenance manager
  (`database-materialized-views.ts` `subscribeToSchemaChanges`) keys off `table_*` events only,
  so `view_modified` cannot trigger a spurious MV rebuild.
- **Optimizer-cache invalidation.** Firing `view_modified` here is strictly *additional*
  invalidation over the old "fire nothing": a cached write-through plan with a `view`
  dependency (keyed by view name) now invalidates; a cached plain `select … from v` inlines the
  body and depends on the underlying table, already invalidated by the rename's own
  `table_modified`. At worst a redundant recompile, never less correct. Not separately tested —
  reviewer may want a plan-cache assertion if they consider it load-bearing.
- **Event ordering** within one ALTER is `table_modified` (renamed table) → per dependent-table
  `table_modified` → per dependent-view `view_modified`. The store serializes on `persistQueue`,
  so the specs assert event *counts/contents*, not a brittle exact sequence.

## Known gaps / deferrals (honest handoff — treat tests as a floor)

- **Store round-trip spec deferred.** The plan listed an *optional* store-package spec
  (create view over t → rename → close → reopen → view DDL references `t2`). I did **not** add
  it — the engine-side `generateViewDDL(newObject)` assertions already pin the load-bearing fact
  (the event carries re-persistable rewritten DDL), and `view-mv-ddl-persistence.spec.ts` lives
  in `packages/quereus` (engine), not the store package. If the reviewer wants end-to-end store
  coverage, the natural home is a `packages/quereus-store` spec asserting reopen rehydration;
  `store-module.ts` `saveViewDDL` is already wired, so this is purely additional confidence.
- **Materialized views are NOT handled** — out of scope by design. An MV over a renamed source
  is neither rewritten nor marked stale (propagation never walks `getAllMaterializedViews()`;
  the MV staleness listener matches the rename event by the *new* name while `sourceTables`
  holds the *old* name). Tracked in `tickets/backlog/mv-body-not-rewritten-on-source-rename.md`
  (already filed, verified present). Do not expand this change to cover it.
- **Cross-schema views** referencing the renamed table are still not rewritten — pre-existing
  scoping (the view loop only runs for views in the renamed object's own schema). Unchanged by
  this ticket; a separate gap if it matters.
- **`yarn test:store` not run** — the LevelDB store path was not exercised here (engine suite
  only). The store consumer code is unchanged, so this is low-risk, but a store-suite run is the
  one validation I skipped. Flagging per the pre-existing-failure protocol mindset, though no
  failure was observed.

## Review checklist

- [ ] Both view loops fire `view_modified` symmetrically (table-rename AND column-rename paths).
- [ ] `objectName` is the view's own (unchanged) name; `newObject.sql` reflects the new
      table/column name; `generateViewDDL(newObject)` is re-persistable.
- [ ] No `view_modified` consumer reads `oldObject.selectAst`/`oldObject.sql` (shared-mutated AST).
- [ ] Docs (`change-events.ts` comment + `docs/schema.md` row) accurately describe both sources.
- [ ] No-op / unrelated-view / multi-view counts are correct (one event per *changed* view only).
- [ ] Confirm MV gap stays out of scope (backlog ticket covers it).
