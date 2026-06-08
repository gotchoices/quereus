description: ALTER TABLE/COLUMN RENAME rewrites dependent plain-view bodies in place but fires NO schema-change event, so a store-backed catalog that persists views from `view_added`/`view_modified` events lets its stored view DDL drift after a rename. Surfaced reviewing `view-mv-persistence-engine-support`.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts          # propagateTableRenameInSchema / propagateColumnRenameInSchema — the silent schema.addView(updatedView) calls
  - packages/quereus/src/schema/change-events.ts              # ViewModifiedEvent (currently fires only on ALTER VIEW … SET TAGS)
  - packages/quereus/src/schema/manager.ts                    # updateViewTags fires view_modified; importView registers from DDL
  - docs/schema.md                                            # event table; view_modified currently documented as SET-TAGS-only
----

# View body rewrites from RENAME propagation fire no schema-change event

## The gap

`ALTER TABLE t RENAME TO t2` (and `ALTER TABLE t RENAME COLUMN a TO b`) propagate the
rename into every dependent view in the same schema: `propagateTableRenameInSchema` /
`propagateColumnRenameInSchema` in `alter-table.ts` mutate each view's `selectAst` in
place and re-register it via `schema.addView({ ...view, sql: astToString(view.selectAst) })`.

The sibling table loop in those same functions fires `table_modified` after each
`schema.addTable(updated)`. **The view loop fires nothing.** So a view's stored body
silently changes (`select * from t` → `select * from t2`) with no `view_modified`
(or any) event.

This is pre-existing and harmless for the optimizer's plan cache today (a cached
`select … from v` records a dependency on the *underlying* table `t`, which the rename
*does* invalidate). It becomes a correctness gap the moment a store-backed catalog
persists views by subscribing to `view_added`/`view_removed`/`view_modified` (the engine
support added in `view-mv-persistence-engine-support`): after a rename, the live
`ViewSchema` is correct and `generateViewDDL(view)` returns the rewritten body, but no
event tells the store to re-persist it. On close→reopen the store rehydrates the
**pre-rename** DDL, which then references a table that no longer exists.

## Use case

1. `create table t (id integer primary key)`
2. `create view v as select id from t`   → store persists `create view main.v as select id from t`
3. `alter table t rename to t2`           → view body becomes `select id from t2`, **no event**, store still holds the old DDL
4. close → reopen → store replays `create view main.v as select id from t` → `t` is gone → the view is broken (or import silently registers a body that fails on first query)

## Expected behavior

A rename that rewrites a view's body should fire a schema-change event carrying the
rewritten `ViewSchema`, so an event-driven persistence consumer re-persists it — the
same way the table loop fires `table_modified`. The open design question (needs a
decision): reuse `view_modified` (today documented as SET-TAGS-only — its doc and the
"distinct from a body change" framing would need revising) or introduce a dedicated
body-changed event. Whichever is chosen, the optimizer-cache invalidation semantics
must stay correct (a body rewrite is more than a tag change).

## Secondary note (scope check, not necessarily the same fix)

The rename propagation only walks `schema.getAllViews()` — **materialized views are not
rewritten at all** on a source rename. An MV whose body names a renamed source keeps its
old `selectAst`; today this surfaces as staleness re-validated on `REFRESH`. Confirm
whether MV body rewrite-on-rename is intended to be absent, or is a parallel gap, before
scoping the fix.
