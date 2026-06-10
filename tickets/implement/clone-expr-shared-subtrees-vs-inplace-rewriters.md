description: Make cloneExpr/cloneQueryExpr truly deep — three subtree kinds are still shared by reference with the source AST (WITH-clause CTE bodies, IUD-RETURNING subqueries, window functions), so the in-place rename rewriters running over a clone (schema differ rename reconcile, constraint-builder self-qualifier strip) silently mutate the DECLARED/stored AST. Reproduced for all three channels.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # transformExpr (no windowFunction case → default `{...expr}` shares wf.function/wf.window), mapQueryExprUniform (IUD branch `{ ...query }` shallow), rebuildSelect (`...sel` spread carries withClause by reference)
  - packages/quereus/src/schema/rename-rewriter.ts            # the mutation channels: visitTableRename/visitColumnRename descend into withClause.ctes, IUD stmts, and windowFunction; stripSelfQualifierInCheckExpression descends into windowFunction (CTE bodies are barrier-suppressed there)
  - packages/quereus/src/schema/schema-differ.ts              # declaredIndexCanonicalBody (~line 907) / reconciledDeclaredBody (~line 1077) — clone + in-place inverse-rename over declared ASTs that back recreate DDL
  - packages/quereus/src/planner/building/constraint-builder.ts  # lines ~163-164: cloneExpr + stripSelfQualifierInCheckExpression over the stored constraint AST
  - packages/quereus/src/parser/ast.ts                        # InsertStmt/UpdateStmt/DeleteStmt/WithClause/CommonTableExpr/WindowFunctionExpr/WindowDefinition shapes the deep clone must cover
  - packages/quereus/test/schema/                             # put the regression spec here (clone-expr-isolation.spec.ts)
----

# Deep-clone the three subtree kinds `cloneExpr` still shares with the source AST

## Reproduced bug

`cloneExpr` (scope-transform.ts) promises a deep structural clone, but three subtree
kinds remain shared by reference with the source. The in-place rewriters
(`renameTableInAst`, `renameColumnInCheckExpression`, `stripSelfQualifierInCheckExpression`)
DO descend into all three, so running them over a "clone" mutates the source tree:

1. **WITH-clause CTE bodies** — `rebuildSelect` returns `{ ...sel, … }` and never
   rebuilds `withClause`, so every CTE `query` is shared. Both rename walkers visit
   `stmt.withClause?.ctes` and mutate `TableSource.table.name` / `ColumnExpr.name` there.
2. **IUD-RETURNING subqueries** — `mapQueryExprUniform` returns `{ ...query }` for a
   non-select/non-values `QueryExpr`, sharing `table` (IdentifierExpr — mutated by
   `rewriteIdentifierIfTable`), `assignments` (`a.column` mutated), `where`, `source`,
   `returning`, `upsertClauses` (`uc.conflictTarget` replaced on the shared clause
   object), and `contextValues`.
3. **Window functions** — `transformExpr` has no `windowFunction` case; the default
   branch's `{ ...expr }` shares `wf.function` (FunctionExpr with args) and `wf.window`
   (partitionBy / orderBy expressions). Both rename walkers and the self-qualifier
   strip descend into these and mutate column nodes in place. (This channel was found
   during fix-stage research; the original ticket listed only the first two.)

The high-stakes victims are the schema differ's rename reconcile
(`declaredIndexCanonicalBody` / `reconciledDeclaredBody` in schema-differ.ts), which
inverse-renames a clone of a **declared** CHECK / index-WHERE expression — a leak
corrupts the declared AST that backs recreate DDL, silently and persistently — and the
constraint builder's qualifier strip over the **stored** constraint AST (window-function
channel only; the strip is barrier-suppressed inside CTE bodies).

All channels were reproduced with failing assertions (see Regression test below):
mutating the clone changed `expressionToString(source)` for
`exists (with c as (select x from old_t) select 1 from c)` (table rename),
`(with c as (select v from t) select count(*) from c) > 0` (column rename),
`exists (select sum(v) over (partition by v order by v) from t)` (column rename), and
`exists (insert into old_t (a) values (1) returning a)` (table rename).

## Fix design

Keep **substitution semantics unchanged** for the view-mutation callers; eliminate
**sharing**. "Preserved structurally" (the documented CTE contract) means *no rewrite
applied* — a pure structural clone satisfies it just as well as a reference share.

1. **`rebuildSelect`**: rebuild `withClause` as a pure structural clone — each CTE
   `query` through `cloneQueryExpr` (NOT through the substitution descend — CTE bodies
   must stay un-substituted per the documented contract), copying the `ctes` array,
   each `{ ...cte }`, and the `columns` array. Update the "`with` clause is preserved
   structurally" doc comments on `rebuildSelect` / `mapQueryExprUniform` to say it is
   *cloned without substitution*.
2. **`mapQueryExprUniform` IUD branch**: replace `{ ...query }` with a structural deep
   clone helper (no substitution threading — the view-mutation descent rejects DML
   subqueries anyway, matching the existing comment). Per ast.ts shapes:
   - common: `table: { ...stmt.table }`, `withClause` via the same CTE-clone helper,
     `returning?.map(rc => rc.type === 'all' ? { ...rc } : { ...rc, expr: cloneExpr(rc.expr) })`,
     `contextValues?.map(cv => ({ ...cv, value: cloneExpr(cv.value) }))`,
     `where: stmt.where && cloneExpr(stmt.where)`, copy `schemaPath` array.
   - insert: copy `columns` array, `source: cloneQueryExpr(stmt.source)`,
     `upsertClauses?.map(uc => ({ ...uc, conflictTarget: uc.conflictTarget && [...uc.conflictTarget], assignments: uc.assignments?.map(a => ({ ...a, value: cloneExpr(a.value) })), where: uc.where && cloneExpr(uc.where) }))`.
   - update: `assignments.map(a => ({ ...a, value: cloneExpr(a.value) }))`.
3. **`transformExpr`**: add an explicit `windowFunction` case rebuilding `function`
   (a FunctionExpr — `{ ...f, args: f.args.map(a => transformExpr(a, substitute, descend)) }`)
   and `window` (clone WindowDefinition: `partitionBy?.map(transformExpr…)`,
   `orderBy?.map(ob => ({ ...ob, expr: transformExpr(…) }))`, and deep-copy `frame`
   including `preceding`/`following` bound `value` expressions). **Recommended**: thread
   `substitute`/`descend` through (as written above) rather than a bare clone — window
   args/partitionBy sit in the same scalar scope as sibling projections, and the current
   no-substitution share is itself a latent view-mutation substitution gap (a window
   function over view columns in a user subquery is never rewritten today). If a
   view-mutation regression surfaces from that widening, fall back to a pure structural
   clone there and file a backlog ticket for the substitution gap. Trim the default-case
   comment (`windowFunction` no longer falls through).

No changes to rename-rewriter.ts or the differ are needed — once the clone is truly
deep, the existing in-place contract is sound.

## Regression test

Create `packages/quereus/test/schema/clone-expr-isolation.spec.ts` pinning, for each
channel, that the rewriter DID hit the clone (`changed === true`, rewritten name present
in the clone's stringification) and that the source is byte-stable
(`expressionToString(src)` unchanged). This exact spec reproduced all four failures
during the fix stage (it was run from a scratch location; adjust imports to
`../../src/...` for the test/schema/ location):

```ts
import { expect } from 'chai';
import { parseExpressionString } from '../../src/parser/index.js';
import { cloneExpr } from '../../src/planner/mutation/scope-transform.js';
import { renameTableInAst, renameColumnInCheckExpression } from '../../src/schema/rename-rewriter.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';

describe('cloneExpr isolation vs in-place rename rewriters', () => {
	it('table rename through a CTE body does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (with c as (select x from old_t) select 1 from c)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', 'main');
		expect(changed, 'rewriter should hit the CTE body in the clone').to.equal(true);
		expect(expressionToString(clone)).to.contain('renamed_t');
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through a CTE body does NOT leak into the source AST', () => {
		const src = parseExpressionString('(with c as (select v from t) select count(*) from c) > 0');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', 'main');
		expect(changed, 'rewriter should hit the CTE body in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('column rename through a window function does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (select sum(v) over (partition by v order by v) from t)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameColumnInCheckExpression(clone, 't', 'v', 'w', 'main');
		expect(changed, 'rewriter should hit the window function in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});

	it('table rename through an IUD-RETURNING subquery does NOT leak into the source AST', () => {
		const src = parseExpressionString('exists (insert into old_t (a) values (1) returning a)');
		const before = expressionToString(src);
		const clone = cloneExpr(src);
		const changed = renameTableInAst(clone, 'old_t', 'renamed_t', 'main');
		expect(changed, 'rewriter should hit the IUD target in the clone').to.equal(true);
		expect(expressionToString(src), 'source AST must be byte-stable').to.equal(before);
	});
});
```

Worth adding alongside: an UPDATE-RETURNING case (pins `assignments` channel:
`exists (update old_t set a = a + 1 where a > 0 returning a)` under both table and
column rename) and an upsert case if the parser accepts it in expression position.

## TODO

- Add the structural CTE/withClause clone to `rebuildSelect` (via `cloneQueryExpr`, not the substitution descend); update the two "preserved structurally" doc comments
- Replace `mapQueryExprUniform`'s `{ ...query }` IUD branch with a structural deep-clone helper covering insert/update/delete per ast.ts shapes (table identifier, withClause, source, assignments, where, returning, upsertClauses, contextValues, columns/schemaPath arrays)
- Add the `windowFunction` case to `transformExpr` (substitution-threaded per the recommendation; include `frame` bound value expressions)
- Add `packages/quereus/test/schema/clone-expr-isolation.spec.ts` with the four pinned cases above (plus the UPDATE-RETURNING variant)
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` (full suite — the view-mutation logic tests in test/logic/93.x exercise the substitution callers whose semantics must not shift)
