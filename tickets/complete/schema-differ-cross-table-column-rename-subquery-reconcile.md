description: Differ-side reconcile of cross-table COLUMN renames in CHECK subquery bodies (gap A) and the declared-side scope resolver for owning-table seeded inverse rewrites (gap B), plus resolver threading through the view insert-defaults reconcile. Implemented per the fix-stage design; reviewed, three test gaps closed inline, all green.
files:
  - packages/quereus/src/schema/schema-differ.ts          # resolveDeclaredColumn closure in computeSchemaDiff; cross-table loop + resolver in reconciledDeclaredBody case 'check'; resolver threaded through computeTableAlterDiff, reconciledDeclaredViewDefinition, inverseRenamedViewParts, columnReconciledViewStmt
  - packages/quereus/test/declarative-equivalence.spec.ts # seven tests in describe 'declarative-equivalence: rename without constraint churn' (six from implement + resolver-mapping test from review)
  - packages/quereus/test/schema-differ.spec.ts           # two review-added tests in 'view definition drift' (insert-defaults resolver compare; columnReconciledViewStmt recreate DDL)
  - packages/quereus/src/schema/rename-rewriter.ts        # reference: ResolveColumnInSource, renameColumnInCheckExpression (resolver hook), renameColumnInAst
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference: rewriteTableForColumnRename — the forward-parity contract
  - docs/schema.md                                        # constraint body-change + view insert-defaults sections
----

# Complete: cross-table COLUMN rename reconcile in the differ's CHECK body compare

## What landed

**Gap A — cross-table inverse loop.** `reconciledDeclaredBody` case `'check'` loops over
`columnRenamesByTable` AFTER the owning-table seeded loop, inverse-rewriting each OTHER table's
column renames via the plain scope-aware `renameColumnInAst` (no seed frame, no resolver —
forward parity with `rewriteTableForColumnRename`'s non-owning branch). Map keys (declared/new
table names) are mapped back to OLD seeds via `tableRenames`; the owning table's entry is
skipped by comparing the mapped seed against the ACTUAL owning name. Ordering is owning-first
(load-bearing — the compound counter-example is in the code comment).

**Gap B — declared-side `ResolveColumnInSource`.** `computeSchemaDiff` builds
`resolveDeclaredColumn` (answers from DECLARED column sets, with old→new table-name mapping;
cross-schema → `false`) and threads it through `computeTableAlterDiff` into the owning-table
`renameColumnInCheckExpression` calls, plus the view `insert defaults` expr reconcile in
`inverseRenamedViewParts` (via both `reconciledDeclaredViewDefinition` and
`columnReconciledViewStmt`).

Docs: `docs/schema.md` constraint body-change section describes the two-pass column inverse,
the ordering constraint, and accepted limitations; view-definition section notes the resolver
threading.

## Review findings

**Process:** read the implement diff fresh (commit `bb1bad7d`) before the handoff summary;
traced both rewriter walkers (`renameColumnInAst` scope stack, `renameColumnInCheckExpression`
seed + resolver consult in `isTableInUnaliasedScope`) and the forward propagation
(`propagateColumnRename` / `rewriteTableForColumnRename`) end to end; checked every file the
change touched and the adjacent paths it could have touched; ran lint, tsc, and the full
cross-workspace suite.

**Checked, found sound (no action):**
- Forward/inverse parity: the forward live resolver consults only `schemaManager.getTable`
  (not views), so the declared resolver answering only from `declaredTables` is exact parity.
  Directional duality verified: forward asks about the OLD column name in the pre-rename (live)
  world; inverse asks about the NEW name in the post-rename (declared) world — both are "the
  world the expression's current spelling lives in."
- Casing contracts: the walker's `realSources` carry lowercased schema/table; `declaredTables`
  keys are lowercased; the resolver's comparisons line up throughout.
- Owning-entry skip in the cross-table loop: sound even when the owning table is itself renamed,
  because actual-catalog names are unique (another table's OLD name can never equal the owning
  OLD name) and `resolveRenames` makes a declared NEW name unequal to any OLD name.
- Ordering argument (owning-seeded first, then cross-table): re-derived independently and
  pinned by the compound test; within each pass order-independence follows from the
  `resolveRenames` chain/swap unrepresentability invariant.
- Index compare path (`declaredIndexCanonicalBody`) deliberately left without resolver/cross
  loop: parity-safe, since partial-index predicates cannot contain subqueries or cross-table
  refs (rejected at create), so neither gap is reachable; the hinted-index recreate path
  (`columnReconciledIndexStmt`) already had its own cross-table loop from prior work.
- Assertions: the differ does no body comparison for name-matched assertions (create/drop by
  name only), so renames have no churn surface there.
- Docs: `docs/schema.md` statements match the code as merged (two-pass split, resolver
  semantics, cross-schema and pathological-interleaving limitations, view insert-defaults
  threading).
- Clone discipline (`cloneExpr` before in-place mutation; `bodyAst`/`ddl` never mutated),
  type safety (no `any`, proper `ResolveColumnInSource` import type), resource cleanup in
  tests (`finally { db.close() }`).

**Minor — fixed inline (three untested paths, each mutation-verified to fail without the fix):**
- The resolver's old→new **table-name mapping branch** was untested — it only fires when the
  subquery's FROM table was itself TABLE-renamed while the owning column rename needs the
  resolver. Added declarative-equivalence test: `a.qty → cap` + `lim → lim2` (lim2 keeps its
  `cap`), CHECK `cap <= (select max(cap) from lim2)` — no churn, apply converges, enforcement
  holds, idempotent. Verified the test fails when the mapping is removed.
- The **view insert-defaults resolver path** (flagged untested in the handoff) — added a
  schema-differ unit test: `t.qty → cap` with the clause expr `cap + (select max(cap) from lim)`
  where lim also has `cap` — no spurious recreate. Verified it fails when the resolver arg is
  dropped from the `inverseRenamedViewParts` call.
- The **`columnReconciledViewStmt` recreate DDL** path — this renders actual DDL, where a false
  inverse capture would produce failing DDL (`max(qty)` against a table with no `qty`), not just
  churn. Added a unit test for a hinted view rename: recreate DDL spells the outer ref under the
  OLD name (`extra = qty + …`) while preserving the inner `max(cap)`.

**Major — none filed.** The one adjacent gap found (the clause-expr pass iterates only FROM
tables' renames — the view analogue of gap A for NON-FROM tables) is already filed as
`differ-insert-defaults-expr-nonfrom-rename-drift` (fix/, prereq on this slug); nothing new to
file on top of it.

**Accepted limitations carried forward (documented in code + docs):**
- Cross-schema FROM sources answer `false` from the declared resolver → possible benign churn.
- Pathological rename interleavings keep the forward walker's documented scope-naïveté class;
  churn fails safe to drop+recreate.
- Only one table-declaration order automated (per-table diffs are order-independent; the
  fix-stage repro verified both orders manually).
- `yarn test:store` not run — diff-side pure computation plus shared rewriters already
  exercised by the default suite (per AGENTS.md it is reserved for store-specific diagnosis).

## Validation

- `yarn lint` clean; `tsc --noEmit` clean (packages/quereus).
- Full `yarn test` across all workspaces green — 5659 passing in packages/quereus
  (implement's 5656 + the three review tests), no failures elsewhere.
- All three new tests mutation-verified (each fails against the unfixed code path).
