description: ALTER TABLE … RENAME COLUMN (and RENAME TO, for table-qualified subquery refs inside default exprs) does not rewrite a dependent view's `insert defaults` clause — propagateColumnRename rewrites only `view.selectAst`, so renaming the defaulted base column leaves `d.column` stale and every subsequent insert through the view fails with `tag-target-not-found`.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts    # propagateTableRename (~1324) / propagateColumnRename (~1433) — view loops call renameTableInAst / renameColumnInAst on selectAst only
  - packages/quereus/src/schema/rename-rewriter.ts      # renameColumnInAst / renameTableInAst — expression-level rewriters to reuse for d.expr; d.column needs a base-column-name rewrite
  - packages/quereus/src/schema/view.ts                 # ViewSchema.insertDefaults / MaterializedViewSchema.insertDefaults
  - packages/quereus/src/planner/mutation/single-source.ts  # resolveDefaultForColumn — the write-time hard error the stale name hits
----

# `insert defaults` clause is not rewritten when its base column (or a table in its expr) is renamed

## Reproduction (verified on the live engine, 2026-06-09)

```sql
create table t3 (id integer primary key, name text, created integer not null);
create view v3 as select id, name from t3 insert defaults (created = 99);
alter table t3 rename column created to created_at;
insert into v3 values (1, 'x');
-- ✗ cannot write through view 'v3': 'insert defaults (created = …)' names column
--   'created', which is not a column of the view or its base table 't3'
```

`propagateColumnRename` / `propagateTableRename` rewrite each dependent view's
`selectAst` in place (and fire `view_modified` so a store-backed catalog re-persists),
but never touch `view.insertDefaults`:

- **`d.column`** names a base column of the view's base table; a rename of that column
  must update it (the clause targets base columns by name — the dominant projected-away
  case isn't even visible in the view output, so the body rewrite can't catch it).
- **`d.expr`** is a full expression that may embed subqueries naming tables
  (`insert defaults (created = (select max(c) from audit))`); a table or column rename
  inside those needs the same `renameTableInAst` / `renameColumnInAst` descent the body
  gets. (Top-level column refs cannot occur — the expression is appended to VALUES rows
  and a row-column reference fails at plan time — but subquery-internal refs are legal.)

## Context / parity notes

- The deprecated `default_for.<col>` view-DDL **tag had the identical blind spot** (tag
  keys are opaque strings; nothing renames them), so this is behavior-parity with what
  the clause replaced — but the clause is first-class AST now, and first-class
  constructs are expected to ride rename propagation like the body does.
- The regenerated DDL after the body rewrite (`view_modified` → store re-persist via
  `generateViewDDL`) carries the clause verbatim, so the stale name also persists.
- **Materialized views**: the MV *body* rewrite has since landed
  (`mv-body-not-rewritten-on-source-rename`, complete) — `applyMaterializedViewRewrite`
  in `runtime/emit/materialized-view-helpers.ts` rewrites the body, re-keys derived
  fields, and regenerates/persists the DDL. It carries `insertDefaults` **verbatim**,
  so the stale clause name round-trips into the re-persisted MV DDL exactly as it does
  for plain views. **This ticket therefore owns BOTH fields**: the plain-view clause in
  the `propagate{Table,Column}RenameInSchema` view loops AND
  `MaterializedViewSchema.insertDefaults` (same `ViewInsertDefault` shape) inside the MV
  propagation — rewrite it on the shallow clone in `applyMaterializedViewRewrite`
  *before* `generateMaterializedViewDDL` reads it.

## Expected behavior

- Renaming a base column that an `insert defaults` entry targets updates `d.column`;
  the view continues to write through with the same default.
- Renames descend into `d.expr` (subquery table/column references) exactly as into the
  body.
- A rewrite that only touches the clause (body unchanged) still fires `view_modified`
  (store re-persistence) — extend the `changed` accumulation, don't add a second event.
- Tests: rename-propagation cases in 93.4 (or the alter-table logic file) — rename the
  defaulted base column, insert through the view, assert the default still lands;
  cross-check `view_info` insertability stays `YES`; and a `view_modified`-fires case in
  `view-mv-ddl-persistence.spec.ts` (RENAME describe block already exists there).
