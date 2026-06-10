description: Review the differ-side reconcile of cross-table COLUMN renames in CHECK subquery bodies (gap A) and the declared-side scope resolver for owning-table seeded inverse rewrites (gap B), plus the optional view insert-defaults resolver threading. Implemented per the fix-stage design; build/lint/tsc/full tests green.
files:
  - packages/quereus/src/schema/schema-differ.ts          # resolveDeclaredColumn closure in computeSchemaDiff (~365); cross-table loop + resolver arg in reconciledDeclaredBody case 'check' (~1455); resolver threaded through computeTableAlterDiff, reconciledDeclaredViewDefinition, inverseRenamedViewParts, columnReconciledViewStmt
  - packages/quereus/test/declarative-equivalence.spec.ts # six new tests in describe 'declarative-equivalence: rename without constraint churn' (after the cross-table TABLE-rename regression test)
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference only: rewriteTableForColumnRename — the forward-parity contract the reconcile mirrors
  - packages/quereus/src/schema/rename-rewriter.ts        # reference only: ResolveColumnInSource, renameColumnInCheckExpression (resolver hook), renameColumnInAst (no hook)
  - docs/schema.md                                        # constraint body-change section + view insert-defaults sentence updated
----

# Review: cross-table COLUMN rename reconcile in the differ's CHECK body compare

## What was implemented

Both gaps from the fix-stage findings, exactly per the ticket's design (no deviations):

**Gap A — cross-table inverse loop.** `reconciledDeclaredBody` case `'check'` now loops over
`columnRenamesByTable` AFTER the owning-table seeded loop, inverse-rewriting each OTHER table's
column renames via the plain scope-aware `renameColumnInAst` (no seed frame, no resolver —
forward parity with `rewriteTableForColumnRename`'s non-owning branch). The map key (declared/new
table name) is mapped back to the OLD seed via `tableRenames`, since the qualifier pass has
already normalized the clone's references; the owning table's entry is skipped by comparing the
mapped seed against the function's `tableName` param (the ACTUAL owning name). Ordering is
owning-first — the doc comment in the code carries the compound counter-example.

**Gap B — declared-side `ResolveColumnInSource`.** `computeSchemaDiff` builds
`resolveDeclaredColumn` (answers from DECLARED column sets, with old→new table-name mapping;
cross-schema → `false`) and threads it through `computeTableAlterDiff` into
`reconciledDeclaredBody`, where the owning-table `renameColumnInCheckExpression` calls now pass
it as the 6th arg. Parameter threading was done as plain extra params (no `ReconcileContext`
bundle — the signatures stayed readable).

**Optional stretch — taken.** The view `insert defaults` expr reconcile in
`inverseRenamedViewParts` (the gap-B cousin) now also receives the resolver, plumbed through
`reconciledDeclaredViewDefinition` AND `columnReconciledViewStmt` (all call sites are inside
`computeSchemaDiff`). Note for the reviewer: the `columnReconciledViewStmt` path renders the
recreate DDL of a hinted-renamed view (not just a compare), so the resolver now also shapes that
DDL — analysis says this only makes the inverse more symmetric with the forward
`renameColumnInInsertDefaults` (which takes the live hook), but **no dedicated test covers the
view insert-defaults resolver path**; only the existing view-reconcile tests guard it.

Docs: `docs/schema.md` constraint body-change section rewritten to describe the two-pass column
inverse (owning-seeded-with-resolver, then cross-table plain walk), the ordering constraint, and
the accepted limitations; the view-definition section's insert-defaults sentence notes the
resolver threading.

## Validation performed

- `yarn lint` (packages/quereus) clean; `tsc --noEmit` clean.
- Full `yarn test` across all workspaces green (5656 passing in packages/quereus).
- Six new tests in `declarative-equivalence.spec.ts` (describe block
  `declarative-equivalence: rename without constraint churn`), each asserting diff shape
  (no churn / churn for the regression), apply success, stored CHECK body, enforcement
  (accept + reject probes), and idempotent re-diff:
  - pure cross-table column rename (`lim.cap → capacity`, CHECK on `a` follows)
  - referenced table renamed AND column-renamed in one diff (`lim → lim2` + `cap → capacity`)
  - scope: owning table has a like-named column — only the inner subquery ref reconciles
  - gap B: owning rename whose NEW name collides with the referenced table's column
    (`a.qty → cap`, unqualified `lim.cap` in the subquery) — no churn
  - compound ordering: `a.qty → cap` + `lim.cap → capacity` in one CHECK
  - REGRESSION: genuine body edit (`max` → `min`) layered on the cross-table rename still
    drops+recreates and enforces the edited boundary

## Known gaps / accepted limitations (for the reviewer)

- Cross-schema FROM sources: declared resolver returns `false` (single-schema catalog) →
  possible benign churn where the forward live lookup would not rewrite. Documented in code+docs.
- Pathological rename interleavings (another table's NEW name == owning table's OLD name with
  correlated unqualified refs) keep the forward walker's documented scope-naïveté class; churn
  fails safe to drop+recreate, convergence unaffected.
- Partial-index WHERE predicates deliberately untouched (backends reject cross-table refs /
  subqueries in index predicates at create time, so gap B is unreachable there).
- Tests cover one table-declaration order only (`lim` before `a`); the fix-stage repro verified
  apply succeeds in both orders, but no automated test pins the reverse order.
- `yarn test:store` (LevelDB-backed re-run) was not run — per AGENTS.md it is reserved for
  store-specific diagnosis; the changes are diff-side (pure computation) plus shared rewriters
  already exercised by the default suite.
