description: ALTER TABLE/COLUMN RENAME rewrites dependent plain-view bodies in place but fires NO schema-change event, so a store-backed catalog that persists views from view_added/view_modified lets stored view DDL drift after a rename. Fix: fire `view_modified` from both rename-propagation view loops (reuse the existing event, not a new one).
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          # propagateTableRenameInSchema (~L1322-1330) / propagateColumnRenameInSchema (~L1410-1418) — the silent schema.addView(updatedView) view loops
  - packages/quereus/src/schema/change-events.ts              # ViewModifiedEvent doc comment (~L65-72) — revise "SET-TAGS-only" framing
  - docs/schema.md                                            # event table row for view_modified (~L438)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts     # add rename → view_modified coverage here (same captureEvents harness)
  - packages/quereus-store/src/common/store-module.ts         # READ-ONLY confirmation: view_added/view_modified already both → saveViewDDL (~L1867); no store change needed
----

# Fire `view_modified` when a RENAME rewrites a plain view's body

## The fix (decided)

`ALTER TABLE t RENAME TO t2` and `ALTER TABLE t RENAME COLUMN a TO b` propagate the
rename into every dependent plain view in the same schema. The two propagation helpers
in `alter-table.ts` each mutate a view's `selectAst` in place and re-register it:

```ts
// propagateTableRenameInSchema  (~L1322-1330)
for (const view of Array.from(schema.getAllViews())) {
    const changed = renameTableInAst(view.selectAst, oldName, newName, renamedSchemaName);
    if (changed) {
        const updatedView = { ...view, sql: astToString(view.selectAst) };
        schema.addView(updatedView);
        // ← NO EVENT FIRED
    }
}
```

The sibling **table** loop directly above it fires `table_modified` after each
`schema.addTable(updated)`. The **view** loop fires nothing. Add the symmetric
`view_modified` notify to **both** view loops (table-rename and column-rename):

```ts
const updatedView = { ...view, sql: astToString(view.selectAst) };
schema.addView(updatedView);
notifier.notifyChange({
    type: 'view_modified',
    schemaName: schema.name,
    objectName: updatedView.name,   // view's own name is unchanged by the rename; canonical stored name
    oldObject: view,
    newObject: updatedView,
});
```

The `notifier` is already a parameter of both `propagateTableRenameInSchema` and
`propagateColumnRenameInSchema`, so no plumbing change is needed.

## Why reuse `view_modified` (not a dedicated body-changed event)

Settled — do **not** add a new event type. Three reasons, all verified in-tree:

1. **Store consumer already handles it identically.** `store-module.ts` `onEngineSchemaChange`
   routes `view_added` *and* `view_modified` to the same `saveViewDDL(view)` →
   `persistObjectCatalogEntryIfChanged(generateViewDDL(view))` (compare-write, skip
   identical). A body rewrite needs exactly that re-persist and nothing more. A new event
   type would force a parallel handler for zero behavioral difference — not DRY.

2. **Optimizer-cache invalidation stays correct, and is strictly safer than today.** A
   cached *write-through* plan over a view records a `view` dependency keyed by view name;
   `view_modified` carries `objectName: view.name` → matches → invalidates. A cached plain
   `select … from v` inlines the body and depends on the underlying **table** `t`, which the
   rename's own `table_modified(t→t2)` already invalidates. So firing `view_modified` here is
   *additional* invalidation over today's "fire nothing" — never less correct, at worst a
   redundant recompile of a write-through plan.

3. **No maintenance re-registration risk for plain views.** Only the MV maintenance manager
   subscribes to schema events, and it listens to `table_*` / `materialized_view_*` only —
   nothing keys off `view_modified`. So the event cannot trigger a spurious rebuild.

The one cost is documentation: `view_modified` is no longer "SET-TAGS-only." Revise the doc
comment on `ViewModifiedEvent` in `change-events.ts` (drop "currently only `ALTER VIEW … SET
TAGS`" and the "distinct from a body change" framing — it now ALSO fires when a RENAME rewrites
the body) and the `view_modified` row in `docs/schema.md` (§ schema-change events table, ~L438:
add "or when an ALTER TABLE/COLUMN RENAME rewrites a dependent view body").

## `oldObject` shares the mutated AST — accepted, mirrors the table loop

`renameTableInAst` / `renameColumnInAst` mutate `view.selectAst` **in place**, so by the time
the event is built `oldObject.selectAst` already points at the *rewritten* AST (only the
freshly-computed `newObject.sql` string differs). This is the **same** shared-mutated-sub-AST
pattern the adjacent table loop already ships (`rewriteTableForTableRename` mutates `cc.expr`
in place, then fires `oldObject: table, newObject: updated`). No consumer reads
`oldObject.selectAst`/`oldObject.sql` for views (store reads `newObject`; plan cache matches by
name), so do **not** add defensive AST cloning — just mirror the existing pattern. Note this in
a one-line code comment so a reviewer doesn't flag it as a bug.

## Edge cases & interactions

- **Multiple dependent views rewritten by one rename** → one `view_modified` per *changed*
  view. Assert N events for N rewritten views; a view whose body does not name the renamed
  object (`changed === false`) fires **nothing** (no `schema.addView`, no event).
- **Column rename path** is a separate helper (`propagateColumnRenameInSchema`) — it has the
  identical silent loop and MUST get the identical fix. A test must cover the column-rename
  case independently, not just table-rename.
- **Event ordering within one ALTER**: primary `table_modified` (the renamed table) → per
  dependent-table `table_modified` → per dependent-view `view_modified`. The store's
  `enqueuePersist` serializes these on `persistQueue`, so order is preserved; assert the
  store round-trip (below), not a brittle exact-event-sequence.
- **Cross-schema views**: the view loop only runs for views in the renamed object's own schema
  (`schema.name.toLowerCase() === renamedSchemaLower`) — unchanged, pre-existing scoping. A
  view in another schema referencing the table is already not rewritten; do not expand scope
  here (that is a separate gap, not this ticket).
- **No-op / case-only rename**: `renameTableInAst` returns `changed === false` when nothing
  matched → no event. Don't fire on a no-op.
- **Interaction with `view-mv-persistence-engine-support`** (already landed): the store
  consumer needs **no** change — `view_modified` is already wired to `saveViewDDL`. Confirm
  the existing `view-mv-ddl-persistence.spec.ts` still passes and that `generateViewDDL` of the
  event's `newObject` references the **new** table/column name.
- **Materialized views are NOT covered by this ticket** — the propagation walks
  `getAllTables()`/`getAllViews()` only, never `getAllMaterializedViews()`, and the MV
  staleness listener matches the rename event by the *new* name while the MV's `sourceTables`
  still holds the *old* name (so an MV over a renamed source is neither rewritten nor marked
  stale). That is a distinct, larger gap filed separately as
  `mv-body-not-rewritten-on-source-rename` (backlog). Do not pull it into this change.

## Key tests (extend `packages/quereus/test/view-mv-ddl-persistence.spec.ts`)

Reuse the file's existing `captureEvents(db, fn)` helper and `generateViewDDL` import.

- **table rename fires view_modified with rewritten body**
  - `create table t (id integer primary key); create view v as select id from t;`
  - `captureEvents(db, () => db.exec('alter table t rename to t2'))`
  - expect exactly one `view_modified` with `objectName === 'v'`, `schemaName === 'main'`
  - `generateViewDDL(event.newObject)` contains `t2` and not a bare `from t`
- **column rename fires view_modified with rewritten body**
  - `create table t (id integer primary key); create view v as select id from t;`
  - `alter table t rename column id to ident`
  - expect one `view_modified` for `v`; `generateViewDDL(newObject)` references `ident`
- **no spurious event for an unrelated view**
  - second view `create view w as select 1 as a;` (does not name `t`)
  - after `alter table t rename to t2`, no `view_modified` carries `objectName === 'w'`
- **two dependent views → two events**
  - `v1 as select id from t`, `v2 as select id from t`; one rename → two `view_modified`
    (one per view), each DDL rewritten
- (optional, light) **store round-trip** — if a store-package spec is the natural home, assert
  create view over t → `alter table t rename to t2` → close → reopen rehydrates the view DDL
  referencing `t2`. If this is awkward to place, the engine-side `generateViewDDL(newObject)`
  assertions above already pin the load-bearing fact (the event carries re-persistable
  rewritten DDL); note any deferral in the review handoff.

## TODO

- Add the `view_modified` `notifyChange` to the view loop in `propagateTableRenameInSchema`
  (alter-table.ts ~L1322-1330), with a one-line comment noting the shared-mutated-AST `oldObject`.
- Add the identical `notifyChange` to the view loop in `propagateColumnRenameInSchema`
  (~L1410-1418).
- Revise the `ViewModifiedEvent` doc comment in `change-events.ts` to include
  RENAME-driven body rewrites (no longer SET-TAGS-only).
- Update the `view_modified` row in `docs/schema.md` (~L438) to mention RENAME body rewrites.
- Add the four engine specs above to `view-mv-ddl-persistence.spec.ts`.
- `yarn workspace @quereus/quereus run build`, then run `view-mv-ddl-persistence.spec.ts` and
  `test/logic/41.3-alter-rename-propagation.sqllogic` (and the broader `yarn test`) — confirm
  green, including no regression in `view-tag-mutation-plan.spec.ts`.
