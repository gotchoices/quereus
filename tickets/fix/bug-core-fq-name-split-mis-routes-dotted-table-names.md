----
description: A table whose quoted name contains a dot (for example a table literally named "a.b") can be mis-identified inside the SQL engine's change-tracking code, so watchers, assertions, materialized views, and explain output may look up the wrong table or none at all.
files:
  - packages/quereus/src/core/database-watchers.ts        # ~81 getRowCount(base)
  - packages/quereus/src/core/database-assertions.ts      # ~148, ~302
  - packages/quereus/src/core/database-materialized-views.ts # ~978 plan.sourceBase
  - packages/quereus/src/func/builtins/explain.ts         # ~1030
difficulty: medium
----

# Core engine: fully-qualified `schema.table` names are re-split on `.`

## Problem

Several places in `packages/quereus` build a fully-qualified base-table name by
joining schema and table with a dot (`` `${schemaName}.${objectName}` ``), then
later recover the pair with `base.split('.')` and destructure the first two
elements. SQL permits a dot inside a quoted identifier:

```sql
create table "a.b" (id integer primary key, v text);
```

`'main.a.b'.split('.')` yields `['main', 'a', 'b']`, so the table name becomes
`'a'` and the trailing segment is dropped. Downstream the engine then looks up a
table that does not exist (or, worse, a different table that does).

This is the same defect class already fixed in `@quereus/store`
(`buildDataStoreName`) and `@quereus/sync`
(ticket `bug-sync-tablekey-split-mis-routes-dotted-identifiers`). Those fixes did
not touch the core engine.

## Expected behavior

Watch subscriptions, assertion evaluation, materialized-view refresh, and
`explain` on a table whose quoted name contains a dot must resolve that exact
table. No silent truncation, no silent no-op.

## Notes

- Prefer carrying the `(schema, table)` pair forward rather than re-splitting a
  joined key. Where a flat key must be persisted or compared, split on the
  **first** dot only, or use a delimiter identifiers cannot contain.
- Beware the mirror-image ambiguity: a joined key is also ambiguous when the
  *schema* name contains a dot. Dotted schema names are effectively unreachable
  in practice; the accepted convention elsewhere in the repo is to fix the
  dotted-table case and document the dotted-schema case.
- Impact varies per site. `getRowCount` degrades to `undefined` (a costing
  fallback, harmless). The watcher/assertion invalidation and materialized-view
  source lookups are the ones that can produce wrong results or missed
  notifications — start there.
- A regression test in the style of
  `packages/quereus-sync/test/sync/dotted-table-name.spec.ts` (create `"a.b"`,
  drive each feature, assert the full name survives) is the cheapest way to
  confirm the repro before fixing.
