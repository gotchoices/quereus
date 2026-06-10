description: Differ-side reconcile only inverse-applies the OWNING table's rename to CHECK / partial-index WHERE bodies — a subquery inside those bodies referencing ANOTHER table renamed in the same diff still churns a benign (converging) drop+recreate, even though the forward rename propagation rewrites those cross-table references.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (selfRename only); computeSchemaDiff index loop (threads only indexTableRename)
  - packages/quereus/src/runtime/emit/alter-table.ts      # rewriteTableForTableRename — the forward path rewrites EVERY table's checks/index predicates, not just the renamed table's own
  - packages/quereus/src/schema/rename-rewriter.ts        # renameTableInAst already handles subquery FROM sources and qualified refs
----

# Cross-table rename references in CHECK / index-predicate subqueries are not reconciled diff-side

## The asymmetry

The forward rename propagation (`rewriteTableForTableRename` in alter-table.ts) walks
**every** table in the schema and rewrites the renamed table's name into each one's CHECK
expressions and partial-index predicates — including subquery FROM sources and qualified
column refs inside them (`renameTableInAst` descends into `exists`/`in`/scalar subqueries).

The differ-side inverse reconcile (landed by `schema-differ-predicate-table-qualifier-reconcile`)
only inverse-applies the **owning table's own** rename:

- `reconciledDeclaredBody` case `'check'` looks up `tableRenames` by `r.oldName === tableName`
  (the constraint's own table) and applies just that one rename to the cloned expression.
- the `computeSchemaDiff` index loop threads just `indexTableRename` (the index's own table,
  matched by `r.newName === indexStmt.table.name`) into `declaredIndexCanonicalBody`.

So a body like

```sql
table a { ..., constraint chk check (qty <= (select max(cap) from lim)) }
```

where `lim` is renamed to `lim2` **in the same diff** renders `… from lim2` on the declared
side vs `… from lim` on the actual side, mismatches after reconciliation, and emits a
drop+recreate of `chk` (or of the index, for a partial-WHERE subquery) on top of the rename.

## Why it is benign (and why it still might be worth fixing)

The recreate carries the NEW name and `generateMigrationDDL` orders renames before adds, so
the apply succeeds and the next diff cycle is empty — converging churn, the same class the
self-qualifier ticket fixed. But:

- a CHECK drop+add is forward-enforcing only (no retro-validation) and non-atomic on the
  memory backend;
- an index drop+recreate is a full rebuild — wasteful for a pure rename;
- a UNIQUE/FK recreate re-validates all rows.

## Expected behavior

A pure rename of any table referenced anywhere in a declared CHECK / partial-index WHERE
body (including subqueries) reconciles to no body churn, exactly like the self-reference
case. A genuine body edit layered on the rename still recreates.

## Sketch

The diff side already has all table renames in hand at both call sites. Applying the inverse
rewrite for **every** in-diff table rename (not just the owning table's) over the same clone
would mirror the forward path's all-tables loop. The same scope-naïveté accepted for the
self-rename (a subquery alias equal to a new table name → spurious valid recreate) applies
per-rename. Note the rendered canonical body does NOT case-fold inside subqueries
(`lowerExprIdentifiers` passes subquery nodes through structurally), so exact-name matching
considerations are symmetric on both sides.
