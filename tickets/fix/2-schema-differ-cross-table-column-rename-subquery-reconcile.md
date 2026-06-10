description: A CHECK whose subquery references ANOTHER table's column churns a benign drop+recreate when that column is renamed in the same diff — the differ's CHECK reconcile applies only the OWNING table's column renames, while the forward propagation rewrites every table's CHECKs. Sibling of the (fixed) cross-table TABLE-rename gap.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (~1095): only `colRenames` (owning table) applied; `columnRenamesByTable` is already threaded in (used by the FK branch) but ignored by the CHECK branch
  - packages/quereus/src/runtime/emit/alter-table.ts      # propagateColumnRenameInSchema / rewriteTableForColumnRename — the forward path walks ALL tables' CHECKs, scope-aware via resolveColumnInSource
  - packages/quereus/src/schema/rename-rewriter.ts        # renameColumnInCheckExpression + ResolveColumnInSource hook
  - packages/quereus/test/declarative-equivalence.spec.ts # cross-table TABLE-rename tests at ~2978 are the pattern to mirror
----

# Reconcile cross-table COLUMN renames in CHECK subquery bodies (diff side)

## Expected behavior

Given a CHECK on table `a` whose subquery references another table's column:

```sql
declare schema main {
  table lim { id INTEGER PRIMARY KEY, cap INTEGER }
  table a { id INTEGER PRIMARY KEY, qty INTEGER,
            constraint chk check (qty <= (select max(cap) from lim)) }
}
apply schema main
-- then rename lim.cap → capacity (column previous_name hint), CHECK follows the new name
```

the diff should emit ONLY the column rename — no `constraintsToDrop: ["chk"]` / `constraintsToAdd` churn on `a`. Today (analysis-predicted, not yet reproduced) it churns: `reconciledDeclaredBody` case `'check'` applies only the owning table's `colRenames`, so the declared `max(capacity)` never reconciles back to the actual `max(cap)`.

The churn is expected to be **benign and converging** (same class as the fixed table-rename sibling): the forward propagation (`propagateColumnRenameInSchema`) walks ALL tables in ALL schemas and rewrites stored CHECK bodies scope-aware, so the re-diff is empty. Confirm that during reproduction.

## Why this is harder than the table-rename fix

The table-rename generalization (see complete ticket `schema-differ-cross-table-rename-subquery-reconcile`) could loop `renameTableInAst` over all renames because table references are unambiguous. Column renames are scope-sensitive: an unqualified column inside a subquery resolves against the subquery's FROM tables, not the owning table. The forward rewriter handles this with the `ResolveColumnInSource` callback (looks up whether a FROM source actually has the column); the differ currently calls `renameColumnInCheckExpression` WITHOUT that hook and has no live schema — only the declared AST and the actual `SchemaCatalog`, from which an equivalent resolver would need to be built.

Key available ingredients:
- `columnRenamesByTable` (declared/new table name → that table's column renames) is already computed in `computeSchemaDiff`'s pre-pass and threaded into `reconciledDeclaredBody` for the FK-parent reconcile — the CHECK branch just doesn't use it.
- The qualifier pass (all-renames table inverse-rewrite) runs FIRST, so by the time column rewrites apply, table references in the clone carry OLD names — meaning a cross-table column rewrite would be seeded with the referenced table's OLD name, but `columnRenamesByTable` is keyed by NEW name (the table renames provide the mapping).

## Scope notes

- Partial-index WHERE predicates are NOT affected: backends reject any cross-table reference in index predicates at create time, and the predicate's `colRenames` (own table only) already cover everything representable.
- Same diff combining a cross-table TABLE rename and a cross-table COLUMN rename on the referenced table should be exercised (the table qualifier pass and the column seed interact).
- A regression guard mirroring the existing pattern: a genuine body edit layered on the cross-table column rename must still drop+recreate.
