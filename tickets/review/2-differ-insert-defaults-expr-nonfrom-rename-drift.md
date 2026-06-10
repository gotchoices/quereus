description: Review the cross-table (non-FROM) column-rename pass added to the differ's `insert defaults` clause-expr inverse reconciliation in `inverseRenamedViewParts` — a rename on a non-FROM table referenced in a clause-expr subquery now converges as a pure rename instead of a spurious view drop+recreate / MV rebuild.
files:
  - packages/quereus/src/schema/schema-differ.ts            # inverseRenamedViewParts — new cross-table pass after the FROM-seeded loop (~line 1180); doc comment clause paragraph updated (~line 1101)
  - packages/quereus/src/schema/rename-rewriter.ts          # reference only: renameColumnInInsertDefaults (forward mirror, ~line 965), renameColumnInAst, renameColumnInCheckExpression
  - packages/quereus/test/schema-differ.spec.ts             # makeCatalog MV param + catalogMaterializedView helper; 2 new specs in 'view definition drift'
  - docs/schema.md                                          # view/MV definition-change paragraph — clause-expr reconcile sentence rewritten as the two-pass split
----

# Review: differ clause-expr cross-table column-rename reconcile

## What was implemented

`inverseRenamedViewParts` (schema-differ.ts) reconciled a view's `insert
defaults` clause exprs by applying column renames only for the view's FROM
tables (seeded `renameColumnInCheckExpression` loop). A rename on a table NOT
in the view's FROM, referenced inside a clause-expr subquery, reconciled the
body but not the clause → canonical strings differed → spurious drop+recreate
(plain view) / rebuild (MV).

The fix appends a cross-table pass after the FROM-seeded loop inside the
`insertDefaults.map` callback — the body pass's exact iteration over
`columnRenamesByTable`, skipping FROM tables (just handled seeded), each walk
seeded with `ownRename?.oldName ?? declaredTableName` and applied via the
plain scope-aware `renameColumnInAst` (no seed frame, no resolver — forward
parity with `renameColumnInInsertDefaults`'s non-FROM branch).

Design pins honored (mirroring the landed gap-A shape — see
tickets/complete/schema-differ-cross-table-column-rename-subquery-reconcile.md):

- FROM-seeded pass first, cross-table second (owning-first ordering is
  load-bearing; documented in the doc comment).
- `fromTables.has` skip is exact: both sides are lowercased DECLARED names.
- The `column` target pass is unchanged — still FROM-scoped (pinned by the
  existing "FROM-scoped lookup" spec, which still passes).
- Shared-path side effect documented in the inline comment:
  `columnReconciledViewStmt` shares this code with `tableRenames: []`, so a
  hinted view-rename recreate DDL now spells the OLD column name for a
  non-FROM clause-expr ref; the post-create forward RENAME COLUMN propagation
  rewrites it forward again — both spellings converge (clause exprs plan
  lazily at write-through time).

Doc updates: the `clause:` paragraph of the `inverseRenamedViewParts` doc
comment now describes the two-pass split; docs/schema.md's view/MV
definition-change paragraph likewise.

## Tests added (schema-differ.spec.ts, 'view definition drift')

- Plain view: `audit.c → c2` referenced only via `(select max(c2) from audit)`
  in the clause expr → empty viewsToDrop/viewsToCreate, RENAME COLUMN present
  on audit's alter diff.
- MV twin: same shape against the bodyHash compare → empty
  materializedViewsToDrop/Create.

Helper extensions: `makeCatalog` gained a third `materializedViews` param
(default `[]`, no existing call sites changed); new `catalogMaterializedView(sql)`
helper builds a `CatalogMaterializedView` the way `materializedViewSchemaToCatalog`
does (`computeBodyHash` over `viewDefinitionToCanonicalString`).

**Mutation-verified**: with the cross-table pass removed, BOTH new specs fail
(each verified individually — `test:single` bails on first failure); restored,
all green.

## Validation run

- `yarn typecheck` (tsc --noEmit) — clean
- `yarn lint` — clean
- Targeted: schema-differ.spec.ts + declarative-equivalence.spec.ts +
  schema/differ-alter-column.spec.ts — 157 passing (155 pre-existing + 2 new)
- Full `yarn test` (all workspaces) — green; 5661 passing in the main quereus
  suite. (`test:full` / store-backed run not executed — no store-path code
  touched; differ is pure catalog comparison.)

## Known gaps / notes for review

- No end-to-end `apply schema` sqllogic test was added — coverage is at the
  `computeSchemaDiff` unit level, consistent with the sibling clause-expr
  specs in the same describe block. The gap-A complete ticket's review
  accepted the same altitude.
- The hinted-view-rename + non-FROM-clause-ref combination (the shared-path
  side effect: recreate DDL spelling the OLD name) is documented but has no
  dedicated spec; the existing 'hinted view rename renders its recreate DDL'
  spec covers the FROM-table variant of that path. If the reviewer wants the
  cross-table variant pinned, it's a small additional spec.
- Derived-table subqueries in the view's FROM remain outside
  `collectFromTableNames` (pre-existing, documented limitation — worst case a
  benign spurious recreate); unchanged by this ticket.
