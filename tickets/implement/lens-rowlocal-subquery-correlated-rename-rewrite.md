description: |
  Make `rewriteToBasisTerms` (planner/mutation/lens-enforcement.ts) scope-aware so a row-local lens
  CHECK whose subquery **correlates** a write-row column with a logical≠basis name rewrites that
  correlated ref to its basis spelling. Today the rewrite calls `transformExpr` WITHOUT the `descend`
  argument, so subquery operands pass through verbatim: a correlated bare write-row ref inside the
  subquery keeps its logical name and crashes at constraint build with `Column not found: <logicalName>`
  when logical≠basis (e.g. `docKey`→`doc_key`). Confirmed reproducible (single-source AND decomposition);
  the crash is `QuereusError: Column not found: docKey` at `constraint-builder.ts:108` →
  `buildSelectStmt` → `resolveColumn`. Residual of `lens-decomp-row-local-subquery-metadata-gate`, which
  fixed the per-op GATE (routes the constraint onto the owning member via `referencedWriteRowColumns`)
  but explicitly scoped out the REWRITE.
prereq:
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # rewriteToBasisTerms (~L78), collectLensRowLocalConstraints (~L133) — needs ctx + scope-aware descent
  - packages/quereus/src/planner/mutation/scope-transform.ts         # transformScopedExpr / transformScopedQuery + ScopeContext — reuse, do NOT add a new walker
  - packages/quereus/src/planner/mutation/single-source.ts           # makeBaseQualifyScope / makeViewScope — reference ScopeContext implementations to mirror
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # lensRowLocalConstraints (~L343) — sole production caller, already has `ctx`
  - packages/quereus/test/lens-enforcement.spec.ts                   # 3 direct callers of collectLensRowLocalConstraints (L130/148/166) need a ctx arg; ctx-build pattern at L2985
  - packages/quereus/test/lens-put-fanout.spec.ts                    # setupSubqueryCheck (~L1764) + surrogateOptionalAd (docKey→doc_key); add the rename-correlated cases here
----

# Lens row-local subquery CHECK: rewrite a correlated write-row ref with logical≠basis name

## Root cause (confirmed)

`rewriteToBasisTerms` rewrites only the top level of the CHECK expression:

```ts
function rewriteToBasisTerms(expr: AST.Expression, map: ReadonlyMap<string, string>): AST.Expression {
  return transformExpr(expr, (col) => { ... });   // NO `descend` arg ⇒ subquery operands pass through verbatim
}
```

`transformExpr(expr, substitute, descend?)` only descends into `subquery` / `exists` / `in (select …)`
operands when given the third `descend` transformer (scope-transform.ts L42-96). Without it, a logical
column correlated from inside a subquery (`exists (select 1 from Allowed where Allowed.name = docKey)`)
is never rewritten. When logical=basis (`title`) the un-rewritten ref happens to still resolve, which is
exactly why `setupSubqueryCheck`'s existing gate tests use same-named columns and never tripped this.
When logical≠basis (`docKey` vs basis `doc_key`) the built constraint references a column that does not
exist on the basis write row ⇒ crash at build.

Reproduced (temp test, since deleted): single-member decomposition over `surrogateOptionalAd`
(`docKey`→`doc_key`) with `check (exists (select 1 from Allowed where Allowed.name = docKey))`, then
`update x.Doc set title='ok' where docKey='k1'` ⇒ `QuereusError: Column not found: docKey`. Stack:
`buildConstraintChecks` → `buildExpression` (the `<= subquery` / `exists`) → `buildSelectStmt` →
`resolveColumn` (resolve.ts:64).

## Fix: scope-aware rewrite via the shared ScopeContext machinery

Reuse `transformScopedExpr` / `transformScopedQuery` (scope-transform.ts) — the same shadow/taint descent
`single-source.ts` already uses — rather than hand-writing a new walker. The descent owns shadow
accumulation across nested scopes, taint propagation, and sibling-leg scoping; the caller supplies only a
`ScopeContext` whose `makeSubstitute(shadowed, tainted)` decides per-column.

`transformScopedExpr(ctx, scope, expr)` enters at the outermost scope (`NO_SHADOW`, untainted) — so a
top-level bare logical column still maps to basis exactly as today — and descends scope-aware into every
subquery operand, where it leaves subquery-local same-named columns untouched.

### Substitution rule (the new ScopeContext)

The rewrite must distinguish a **correlated write-row ref** (a logical column of this table) from a
**subquery-local** ref. Model it on `makeViewScope` / `makeBaseQualifyScope` in single-source.ts. Pass
the logical table name so a qualified write-row ref is recognized (mirrors `makeViewScope`'s `lcView`
check). Per column:

- **Qualified** (`col.table` set):
  - qualifier === the logical table name AND the name maps ⇒ a qualified write-row ref ⇒ replace with the
    bare basis column (qualifier dropped so it resolves against the single basis source);
  - any other qualifier (`Allowed.name`, a subquery FROM source) ⇒ `undefined` (leave untouched — it
    resolves against the subquery FROM). **This is the negative-case guard against over-rewriting.**
- **Bare** (`col.table` unset):
  - shadowed by a (this-or-enclosing) subquery FROM ⇒ `undefined` (subquery-local, leave);
  - else, name maps ⇒ replace with the bare basis column (a correlated write-row ref);
  - else ⇒ `undefined`.

Note the existing top-level behavior "strip the qualifier of an *unmapped* qualified column" is dropped:
the prover already errors at deploy on a CHECK over a non-reconstructible column, so every referenced
logical column maps cleanly, and a top-level CHECK qualifier can only name the logical table (CHECKs reach
other tables only via subqueries). Verify the existing `lens-enforcement.spec.ts` rename tests
(`speed as maxSpeed`, `lo as a`/`hi as b`) still pass — they use bare refs and are unaffected.

### Unresolvable-scope policy

Use `unresolvableScope: 'taint'` (mirroring `makeViewScope`): when a subquery's FROM columns can't be
resolved statically (`select *` / TVF / CTE — `collectFromColumnNames` returns `null`), a bare
logical-column-named ref inside it can't be proven correlated. Mirror `makeViewScope` and **reject** such
a ref from the tainted scope with a clear diagnostic (via `raiseMutationDiagnostic`, reason
`unsupported-subquery-correlation`) rather than mis-rewrite or fall through to a cryptic build crash.
A foreign / qualified ref in a tainted scope is still left untouched. Also supply `rejectDmlSubquery`
(an embedded INSERT/UPDATE/DELETE … RETURNING subquery — reject, consistent with the other callers).

### Threading `ctx`

`transformScopedExpr` needs a `PlanningContext` (for `collectFromColumnNames`). So:

- `rewriteToBasisTerms(expr, map)` → `rewriteToBasisTerms(ctx, expr, map, logicalTableName)`.
- `collectLensRowLocalConstraints(slot)` → `collectLensRowLocalConstraints(ctx, slot)`. The logical table
  name is `slot.logicalTable.name`.
- The sole production caller `lensRowLocalConstraints(ctx, view)` (view-mutation-builder.ts ~L343)
  already holds `ctx` — pass it through.

`rowLocalReferencedBasisColumns` (the gate metadata) is unchanged: it already maps logical→basis by
over-collecting every column-ref name, so it stays consistent with the now scope-aware expression — the
gate routes the constraint onto the member owning `doc_key`, and the rewrite makes the expression spell
`doc_key`. (Sanity: assert `referencedWriteRowColumns` still contains `doc_key` for the rename case.)

## Test call-site migration

`collectLensRowLocalConstraints` is called directly (without a ctx) at `lens-enforcement.spec.ts`
L130, L148, L166. Add a `ctx` built with the established pattern already in that file (L2985):

```ts
const ctx: PlanningContext = {
  db, schemaManager: db.schemaManager, parameters: {},
  scope: new ParameterScope(new GlobalScope(db.schemaManager)),
  cteNodes: new Map(), schemaDependencies: new BuildTimeDependencyTracker(),
  schemaCache: new Map(), cteReferenceCache: new Map(), outputScopes: new Map(),
};
```

(`GlobalScope` is already imported at the call to `new GlobalScope(db.schemaManager)`; confirm the import
line exists — it does for the L2989 usage.) Consider a small local helper in the spec to avoid repeating
the literal three times.

## New test coverage (lens-put-fanout.spec.ts, near `setupSubqueryCheck`)

The existing `setupSubqueryCheck` cases deliberately correlate same-named `title`/`note`. Add cases that
correlate the rename pair `docKey` (logical) → `doc_key` (basis), reusing `surrogateOptionalAd`:

- **Decomposition, builds + enforces**: `check (exists (select 1 from Allowed where Allowed.name = docKey))`,
  then `update x.Doc set title='ok' where docKey='k1'` — pre-fix crashes (`Column not found: docKey`),
  post-fix builds; an `Allowed`-listed `docKey` passes and a non-listed one ABORTs at commit (gate routes
  the CHECK onto the `doc_key`-owning anchor — `docKey` IS the key column).
- **Over-rewrite negative**: a subquery whose FROM introduces a column that shares a logical column's
  name (e.g. `from SomeT st where st.doc_key = docKey`, or alias a subquery source column to a logical
  name) — confirm the subquery-LOCAL ref is NOT rewritten to basis (it resolves against the subquery
  FROM), only the correlated `docKey` is. Asserts the shadow guard.
- **Single-source rename**: add a single-source lens (no decomposition — e.g. extend `lens-enforcement.spec.ts`)
  with a `speed as maxSpeed`-style rename and a subquery CHECK correlating `maxSpeed`, proving the fix is
  independent of decomposition (per the ticket: reproduces on a plain single-source lens too).

Where a foreign ref (`Allowed.name`) co-occurs, assert it stays spelled `Allowed.name` in the built
constraint (e.g. via `astToString` on the collected constraint, as the rename test at L130 does).

## Docs

If `docs/lens.md` § Constraint Attachment describes `rewriteToBasisTerms` as top-level-only, update it to
note the rewrite is now scope-aware (correlated subquery write-row refs rewritten; subquery-local refs
preserved). Keep it terse.

## Validation

- `cd packages/quereus && yarn build`
- Targeted: run `lens-put-fanout.spec.ts` and `lens-enforcement.spec.ts` (stream with `tee`):
  `node --import ./register.mjs ../../node_modules/mocha/bin/mocha.js 'test/lens-put-fanout.spec.ts' 'test/lens-enforcement.spec.ts' --reporter spec 2>&1 | tee /tmp/lens.log; tail -n 60 /tmp/lens.log`
  (run from `packages/quereus`; the repo `test-runner.mjs` only takes the fixed glob, so invoke mocha
  directly with the loader for a targeted run — confirmed working during the fix investigation).
- Full: `yarn test` from repo root.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).

## TODO

- Add a `makeLensRewriteScope(map, logicalTableName)` returning a `ScopeContext` in lens-enforcement.ts,
  per the substitution rule above (qualified write-row ref → bare basis; foreign/shadowed → untouched;
  bare mapped unshadowed → bare basis), with `unresolvableScope: 'taint'` + reject-on-tainted-bare-ref and
  `rejectDmlSubquery`, raising via `raiseMutationDiagnostic` (`unsupported-subquery-correlation`).
- Rewrite `rewriteToBasisTerms` to `rewriteToBasisTerms(ctx, expr, map, logicalTableName)` calling
  `transformScopedExpr(ctx, makeLensRewriteScope(map, logicalTableName), expr)`. Import
  `transformScopedExpr` (+ `type ScopeContext`) from scope-transform.js.
- Thread `ctx: PlanningContext` through `collectLensRowLocalConstraints(ctx, slot)`; pass
  `slot.logicalTable.name`. Update the production caller `lensRowLocalConstraints` (view-mutation-builder.ts)
  to forward its `ctx`.
- Update the 3 direct test call sites in lens-enforcement.spec.ts to pass a built `ctx` (helper).
- Add the decomposition rename, over-rewrite-negative, and single-source rename tests above.
- Confirm the existing same-named gate tests (`setupSubqueryCheck` L1784/1803/1819) and the rename
  row-local tests (L116/L146 area) still pass; assert `referencedWriteRowColumns` consistency.
- Update docs/lens.md if it claims top-level-only rewrite.
- Build, targeted tests, full `yarn test`, lint.
