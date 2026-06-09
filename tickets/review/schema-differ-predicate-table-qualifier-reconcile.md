description: Review — differ-side NEW→OLD reconcile of the table qualifier in partial-index WHERE predicates and constraint CHECK expressions under a concurrent table rename, with both paths' column-rewriter seeds aligned to OLD.
prereq: rename-propagation-index-predicate
files:
  - packages/quereus/src/schema/schema-differ.ts          # import; index loop (~485) threads indexTableRename; declaredIndexCanonicalBody (~880-930) qualifier pass + OLD seed; reconciledDeclaredBody case 'check' (~1075) qualifier pass
  - packages/quereus/src/planner/mutation/scope-transform.ts  # rebuildFrom 'table' case now clones the nested table identifier (clone-depth fix)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # 5 new qualified-predicate cases + updated stale comment (~1045)
  - packages/quereus/test/declarative-equivalence.spec.ts # 4 new CHECK cases in "rename without constraint churn"
  - docs/schema.md                                        # constraint + index body-change sections updated
  - tickets/.pre-existing-error.md                        # pre-existing engine gap surfaced by the new tests (see Gaps)
----

# Implemented: predicate/CHECK table-qualifier reconcile NEW→OLD under a table rename

## What changed

All three reproduced churn cases from the fix ticket are closed, per the design:

1. **`declaredIndexCanonicalBody`** (schema-differ.ts) takes a new
   `tableRename: RenameOp | undefined` parameter. The WHERE reconcile now clones when
   *either* a table rename or column renames apply; over the clone it first
   inverse-rewrites the qualifier NEW→OLD via `renameTableInAst` (the exact inverse
   of the forward rewriter the executed rename migration runs, so diff-side and
   migration cannot drift), then runs the per-column rewrites **seeded with the OLD
   table name** (`tableRename?.oldName ?? indexStmt.table.name` — identical to the
   old behavior when no table rename is in play).
2. **`computeSchemaDiff` index loop** finds the index table's in-diff rename by
   matching `r.newName` against `indexStmt.table.name` (same key as the
   colRenames lookup) and threads it in.
3. **`reconciledDeclaredBody` case `'check'`** looks up the table's own rename in the
   already-threaded `tableRenames` by `r.oldName === tableName` (tableName is the
   actual/OLD name there), applies the same inverse qualifier pass on the clone
   BEFORE the existing OLD-seeded column loop — which fixes the seed bug: a
   qualified ref under the NEW table name (`t2.amount`) is normalized to `t.amount`
   first, so the OLD-seeded column reconcile now matches it.
4. **Clone-depth fix in `scope-transform.ts`** (load-bearing, please scrutinize):
   `rebuildFrom`'s `case 'table'` returned `{ ...fc }`, sharing the nested
   `table` identifier object between a `cloneExpr` result and the source AST.
   `renameTableInAst` mutates `ts.table.name` in place, so a subquery FROM source
   inside a reconciled predicate would have leaked the NEW→OLD rewrite back into the
   *declared* AST (which backs the recreate DDL and lives across diffs in
   `declaredSchemaManager`). Now `{ ...fc, table: { ...fc.table } }`. `ColumnExpr`
   nodes were already recreated by `transformExpr`, so the column rewriter was safe.
5. Doc comments on both differ functions and the two affected sections of
   `docs/schema.md` updated (the "a table rename alone never churns" claim is now
   scoped to the column list; the qualified-predicate exception paragraph replaced
   with the reconcile description).

## Validation run

- `yarn build` (tsc) clean; `yarn lint` clean.
- `yarn test` full workspace: exit 0, 5545 passing in `packages/quereus`, no failures
  anywhere.
- Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/<spec>.spec.ts"` from the repo root for both spec files.

## Test coverage added (use these as the review entry points)

`index-ddl-roundtrip.spec.ts` ("declarative differ stability", end of describe):
- qualified `t_old.active` predicate under pure table rename → no churn, rename op only.
- table rename + column rename with `t_new.is_active` qualified ref → no churn on
  both dimensions (seed alignment).
- genuine predicate edit (`= 1` → `= 0`) layered on the table rename → still
  recreates, recreate carries `t_new.active = 0`.
- require-hint: reconciled qualified-predicate table rename trips nothing.
- end-to-end: apply the rename, stored index DDL renders `WHERE t_new.active = 1`,
  re-diff fully empty (renames included) — exercises the prereq's forward
  propagation + this reconcile converging in one cycle.
- pre-existing unqualified-predicate guard updated (comment only) and still passes.

`declarative-equivalence.spec.ts` ("rename without constraint churn"):
- CHECK `t.qty` self-qualified under pure table rename → rename op only; post-apply
  stored `namedConstraints[].definition` renders `t2.qty > 0`; idempotent re-diff.
- CHECK under table rename + column rename (`t2.amount`) → no churn (the seed bug
  case); post-apply definition `t2.amount > 0`; idempotent.
- REGRESSION: genuine CHECK edit (`> 0` → `>= 0`) layered on the rename → still
  drop+recreates; recreated definition `t2.qty >= 0`; idempotent.
- unqualified CHECK under pure table rename → no churn (regression guard).

## Known gaps / honest notes for the reviewer

- **Pre-existing engine gap, NOT fixed here** (flagged in
  `tickets/.pre-existing-error.md` for the triage pass): a table-qualified CHECK
  self-ref is accepted at DDL time and diffs correctly, but `insert` fails at
  plan-build (`resolveColumn: t.qty isn't a column`) even on a freshly created table
  with no rename anywhere. The three new qualified-CHECK tests therefore assert the
  stored catalog `definition` post-apply instead of runtime enforcement (enforcement
  stays covered by the unqualified tests). If triage fixes the resolver, upgrading
  those assertions to real inserts would strengthen them.
- **Accepted scope-naïveté** (documented in code + docs, symmetric with the forward
  path): the rename rewriters don't track aliases inside predicate subqueries, so an
  alias that equals the new table name could inverse-rewrite and cause a spurious
  (but valid) recreate. Not tested — constructing it requires a subquery in an index
  predicate, which the engine barely supports anyway.
- **Residual shared state in `cloneExpr`**: `mapQueryExprUniform` still preserves a
  subquery's `withClause` by reference (and IUD-RETURNING subqueries shallowly), so
  an in-place rewrite *inside a CTE body* of a cloned predicate would still leak.
  Pre-existing for the column rewriter; a CTE inside a CHECK / index WHERE is exotic
  and the fix would change `mapQueryExprUniform` semantics for its substitution
  callers, so I deliberately did not widen it. Worth a backlog note if the reviewer
  disagrees.
- The require-hint index guard needed no code change — a reconciled rename
  contributes zero creates/drops by construction; the test pins it.
- `test:store` was not run (per AGENTS.md it is reserved for store-specific
  diagnosis); the differ and rewriters are storage-agnostic, and the forward
  propagation path was the prereq ticket's concern.
