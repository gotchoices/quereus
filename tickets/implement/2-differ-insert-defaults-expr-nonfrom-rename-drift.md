description: Add the cross-table (non-FROM) column-rename pass to the differ's `insert defaults` clause-expr inverse reconciliation in `inverseRenamedViewParts` — mirroring the body pass and the forward `renameColumnInInsertDefaults` — so a rename on a non-FROM table referenced in a clause-expr subquery converges as a pure rename instead of a spurious view drop+recreate / MV rebuild. Fix shape verified against a live repro during the fix stage.
files:
  - packages/quereus/src/schema/schema-differ.ts            # inverseRenamedViewParts — clause-expr pass (~line 1155); doc comment above it (~line 1101)
  - packages/quereus/src/schema/rename-rewriter.ts          # reference only: renameColumnInInsertDefaults (forward mirror), renameColumnInAst, renameColumnInCheckExpression
  - packages/quereus/test/schema-differ.spec.ts             # new specs in 'view definition drift'; makeCatalog needs an MV param + catalogMaterializedView helper
  - docs/schema.md                                          # view insert-defaults reconcile paragraph
----

# Differ: reconcile non-FROM-table column renames inside `insert defaults` expr

## Root cause (confirmed by repro)

`inverseRenamedViewParts` (schema-differ.ts:1114) reconciles a declared view's
`insert defaults` clause exprs by applying column renames **only for the
view's FROM tables** (seeded `renameColumnInCheckExpression` loop at
~line 1155). The body pass directly above (~line 1132) iterates ALL of
`columnRenamesByTable`; the forward mirror `renameColumnInInsertDefaults`
(rename-rewriter.ts:965) likewise handles a non-FROM renamed table via the
plain scope-aware `renameColumnInAst` branch.

So a declarative diff carrying a column rename on a table that is NOT in the
view's FROM, referenced inside a clause-expr subquery, reconciles the body but
not the clause → canonical strings differ → spurious drop+recreate (plain
view) / drop+recreate-with-rebuild (MV). Reproduced both:

```sql
-- declared
declare schema main {
  table t { id integer primary key, ts integer }
  table audit { id integer primary key, c2 integer with tags ("quereus.previous_name" = 'c') }
  view v as select id from t insert defaults (ts = (select max(c2) from audit))
}
-- catalog: audit(id, c); create view v as select id from t insert defaults (ts = (select max(c) from audit))
-- actual: viewsToDrop ['v'] + recreate (and the MV twin: materializedViewsToDrop ['mv'] + rebuild)
-- expected: no view buckets touched; only audit's RENAME COLUMN c→c2
```

## Verified fix

Append a cross-table pass after the existing FROM-seeded loop inside the
`insertDefaults.map` callback (exactly the body pass's iteration, skipping
FROM tables — they were just handled seeded):

```ts
for (const [declaredTableName, colRenames] of columnRenamesByTable) {
	if (fromTables.has(declaredTableName)) continue;
	const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
	const seedTableName = ownRename?.oldName ?? declaredTableName;
	for (const r of colRenames) {
		renameColumnInAst(exprClone, seedTableName, r.newName, r.oldName, schemaName);
	}
}
```

Prototyped during fix stage: both repro cases converge (empty view/MV
drop+create buckets) and the full existing differ suites stay green
(schema-differ.spec.ts + declarative-equivalence.spec.ts +
schema/differ-alter-column.spec.ts — 155 passing).

Notes on the shape (mirror of the landed gap-A design — see
tickets/complete/schema-differ-cross-table-column-rename-subquery-reconcile.md):

- **Seed mapping**: the inverse table pass already rewrote `exprClone`'s
  qualifiers/FROMs to OLD names, so the walk seeds with
  `ownRename?.oldName ?? declaredTableName` — same as the body pass.
- **Ordering**: FROM-seeded pass first, cross-table pass second — owning-first
  ordering is load-bearing per gap A's review; the `fromTables.has` skip is
  exact because both `fromTables` and `columnRenamesByTable` keys are
  lowercased DECLARED names.
- **Plain walk, no resolver**: forward parity — `renameColumnInInsertDefaults`'s
  non-FROM branch uses plain `renameColumnInAst` (no seed frame, no resolver),
  pinned by 41.3 §20.
- **`column` target pass unchanged**: it stays FROM-scoped
  (an unrelated table's rename must not rewrite the clause target — pinned by
  the existing "FROM-scoped lookup" spec).
- **Shared-path side effect (benign, document in the comment)**:
  `columnReconciledViewStmt` shares `inverseRenamedViewParts` (with
  `tableRenames: []`), so a hinted view-rename recreate DDL now spells the OLD
  column name for a non-FROM clause-expr ref; the post-create forward RENAME
  COLUMN propagation rewrites it forward again. Both spellings converge
  (clause exprs plan lazily at write-through time), but OLD-name rendering is
  consistent with the body handling and with re-diff convergence.
- Update the `clause:` paragraph of the `inverseRenamedViewParts` doc comment
  (~line 1101) to describe the two-pass clause-expr reconcile (seeded FROM +
  plain cross-table), and the matching sentence in docs/schema.md's view
  insert-defaults section.

## Test plan (specs to add in schema-differ.spec.ts, 'view definition drift')

The exact repro fixtures above were exercised live during fix stage. The MV
case needs small test-helper extensions:

- `makeCatalog` gains a `materializedViews: CatalogMaterializedView[] = []`
  param (currently hardcoded `[]`).
- New `catalogMaterializedView(sql)` helper — parse `create materialized view`
  DDL, return `{ name, ddl: sql, bodyHash: computeBodyHash(viewDefinitionToCanonicalString(mv.columns, mv.select, mv.insertDefaults)), tags: mv.tags }`;
  `computeBodyHash` imports from `../src/schema/view.js`. (Verified working
  during fix-stage repro.)

## TODO

- Add the cross-table pass to the clause-expr reconcile in
  `inverseRenamedViewParts` (code above); update its doc comment.
- Extend spec helpers (`makeCatalog` MV param, `catalogMaterializedView`).
- Spec: plain view — non-FROM table column rename referenced in clause-expr
  subquery converges as pure rename (no viewsToDrop/viewsToCreate; the
  RENAME COLUMN op present on the table's alter diff).
- Spec: MV twin — no materializedViewsToDrop/Create (no rebuild).
- Mutation-verify both new specs fail with the cross-table pass removed
  (project review culture — see the prereq's complete ticket).
- Update docs/schema.md view insert-defaults reconcile paragraph.
- Run `yarn lint`, `tsc --noEmit`, and full `yarn test`; hand off to review
  with any gaps stated honestly.
