description: Cross-table (non-FROM) column-rename pass in the differ's `insert defaults` clause-expr inverse reconciliation (`inverseRenamedViewParts`) — a rename on a non-FROM table referenced in a clause-expr subquery now converges as a pure rename instead of a spurious view drop+recreate / MV rebuild. Implemented per the fix-stage design; reviewed, two test gaps closed inline, all green.
files:
  - packages/quereus/src/schema/schema-differ.ts            # inverseRenamedViewParts — cross-table pass after the FROM-seeded loop (~line 1180); doc comment clause paragraph (~line 1101)
  - packages/quereus/src/schema/rename-rewriter.ts          # reference only: renameColumnInInsertDefaults (forward mirror), renameColumnInAst, renameColumnInCheckExpression, collectFromTableNames
  - packages/quereus/test/schema-differ.spec.ts             # makeCatalog MV param + catalogMaterializedView helper; 4 specs in 'view definition drift' (2 implement + 2 review)
  - docs/schema.md                                          # view/MV definition-change paragraph — clause-expr reconcile described as the two-pass split
----

# Complete: differ clause-expr cross-table column-rename reconcile

## What landed

`inverseRenamedViewParts` reconciled a view's `insert defaults` clause exprs by
applying column renames only for the view's FROM tables (seeded
`renameColumnInCheckExpression` loop). A rename on a table NOT in the view's
FROM, referenced inside a clause-expr subquery, reconciled the body but not the
clause → canonical strings differed → spurious drop+recreate (plain view) /
rebuild (MV).

The fix appends a cross-table pass after the FROM-seeded loop inside the
`insertDefaults.map` callback — the body pass's exact iteration over
`columnRenamesByTable`, skipping FROM tables, each walk seeded with
`ownRename?.oldName ?? declaredTableName` and applied via the plain scope-aware
`renameColumnInAst` (no seed frame, no resolver — forward parity with
`renameColumnInInsertDefaults`'s non-FROM branch). FROM-seeded first,
cross-table second — the same owning-first ordering as the constraint CHECK
reconcile (gap A).

Test helpers: `makeCatalog` gained a third `materializedViews` param;
`catalogMaterializedView(sql)` builds a `CatalogMaterializedView` the way
`materializedViewSchemaToCatalog` does (`computeBodyHash` over
`viewDefinitionToCanonicalString`).

Docs: the `clause:` paragraph of the `inverseRenamedViewParts` doc comment and
docs/schema.md's view/MV definition-change paragraph both describe the two-pass
split.

## Review findings

**Process:** read the implement diff fresh (commit `1ceeebfd`) before the
handoff summary; traced the rewriter walkers end to end for the new call shape
(`renameColumnInAst` on a bare clause expr — empty scope stack at top level);
verified the skip-set contract (`collectFromTableNames` lowercases and
same-schema-scopes; `columnRenamesByTable` keys are lowercased declared names —
the `fromTables.has` skip is exact, and the seeded + cross loops partition
`columnRenamesByTable` with no double-handling); confirmed the test helper
mirrors `materializedViewSchemaToCatalog` (backing-module fields omitted on
both sides ⇒ both normalize to `memory`); re-ran the implementer's mutation
check independently; ran lint, tsc, and the full cross-workspace suite.

**Checked, found sound (no action):**
- No false capture at the clause expr's top level: with an empty scope stack,
  `isTableInUnaliasedScope` returns false, so an unqualified top-level ref
  (which binds to the FROM table's inserted-row context) is never rewritten by
  the cross-table walk; qualified refs and subquery-bound refs rewrite with
  exact forward parity (the forward non-FROM branch is the same walker).
- Forward/inverse parity holds even on the walker's documented scope-naïveté
  edges — both directions use the same plain walk, so any false capture is
  symmetric and the apply→re-diff cycle still converges.
- The `column` target pass remains FROM-scoped (pinned by the pre-existing
  "FROM-scoped lookup" spec, which still passes).
- Shared-path side effect (`columnReconciledViewStmt` with `tableRenames: []`):
  the hinted-view-rename recreate DDL spelling the OLD column name for a
  non-FROM clause-expr ref is correct ordering-wise (view creates emit before
  RENAME COLUMN; the OLD name is the one that exists at create time) and
  converges via the post-create forward propagation. Now also pinned by a spec
  (below).
- Clone discipline: the cross-table pass mutates only `exprClone`
  (`cloneExpr`'d per entry); the declared statement is never mutated.
- Type safety (no `any`), DRY altitude acceptable: the 8-line loop mirrors the
  established body-pass/gap-A shape rather than extracting a 4-site shared
  helper — consistent with the gap-A review's accepted tradeoff (local
  parity-readability over abstraction).
- Docs match the merged code (doc comment two-pass paragraph; docs/schema.md
  sentence including the `audit` example and the load-bearing ordering note).

**Minor — fixed inline (two untested paths, each mutation-verified):**
- The **`ownRename` seed mapping** in the new cross-table loop (a non-FROM
  table that is ALSO table-renamed in the same diff) had no coverage. Added a
  spec: `audit → audit2` + `audit.c → c2`, clause expr
  `(select max(c2) from audit2)` — no recreate, table rename op present.
  Mutation-verified: seeding with the declared name instead fails exactly this
  spec.
- The **`columnReconciledViewStmt` recreate-DDL variant** (flagged un-specced
  in the handoff) — added a spec: hinted view rename `v → v2` with the
  non-FROM clause-expr subquery ref; the recreate DDL spells `max(c)` (OLD
  name). This path renders actual DDL, matching the gap-A review's precedent
  of pinning DDL-rendering paths.
- Mutation A (cross-table pass removed entirely) re-run during review: exactly
  the 4 targeted specs fail (2 implement + 2 review), independently confirming
  the implementer's mutation claim.

**Major — none filed.** No correctness, ordering, or parity gaps found beyond
the two inline-fixed coverage gaps.

**Accepted limitations carried forward (documented, unchanged by this ticket):**
- Derived-table subqueries in the view's FROM remain outside
  `collectFromTableNames` — worst case a benign spurious recreate.
- No end-to-end `apply schema` sqllogic test — coverage is at the
  `computeSchemaDiff` unit level, consistent with the sibling clause-expr
  specs and the gap-A review's accepted altitude.
- `yarn test:store` not run — pure catalog comparison, no store-path code
  touched (per AGENTS.md it is reserved for store-specific diagnosis).

## Validation

- `yarn lint` clean; `yarn typecheck` (tsc --noEmit) clean.
- Targeted: schema-differ.spec.ts + declarative-equivalence.spec.ts +
  schema/differ-alter-column.spec.ts — 159 passing (157 + 2 review specs).
- Full `yarn test` across all workspaces green — 5663 passing in
  packages/quereus (implement's 5661 + the two review specs), no failures
  elsewhere.
- Both review specs mutation-verified (each fails against the targeted
  mutation; source restored to committed state afterward, `git diff` clean on
  src before final runs).
