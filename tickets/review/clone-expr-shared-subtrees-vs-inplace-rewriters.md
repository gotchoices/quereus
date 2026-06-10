description: Review — cloneExpr/cloneQueryExpr made truly deep (WITH-clause CTE bodies, IUD-RETURNING subqueries, window functions no longer shared by reference), so in-place rename rewriters over a clone can no longer mutate the DECLARED/stored source AST. All work landed in scope-transform.ts + a new regression spec; no rewriter/differ/constraint-builder changes were needed.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts   # all production changes
  - packages/quereus/test/schema/clone-expr-isolation.spec.ts  # new regression spec (7 cases)
  - packages/quereus/src/schema/rename-rewriter.ts             # unchanged — the in-place mutation channels the clone now isolates
  - packages/quereus/src/schema/schema-differ.ts               # unchanged victim (declaredIndexCanonicalBody / reconciledDeclaredBody)
  - packages/quereus/src/planner/building/constraint-builder.ts # unchanged victim (stripSelfQualifierInCheckExpression over stored AST)
----

# Review: deep-clone the three subtree kinds `cloneExpr` shared with the source AST

## What was wrong

`cloneExpr` / `cloneQueryExpr` (scope-transform.ts) promised a deep structural clone
but shared three subtree kinds by reference: WITH-clause CTE bodies (`rebuildSelect`
never rebuilt `withClause`), IUD-RETURNING subqueries (`mapQueryExprUniform` returned
`{ ...query }` shallow for insert/update/delete), and window functions (`transformExpr`
had no `windowFunction` case, so the default `{ ...expr }` shared `function`/`window`).
The in-place rename rewriters (`renameTableInAst`, `renameColumnInCheckExpression`,
`stripSelfQualifierInCheckExpression`) descend into all three, so running them over a
"clone" mutated the source — corrupting the DECLARED ASTs behind the schema differ's
rename reconcile and the stored constraint AST behind the constraint builder's
qualifier strip.

## What was changed (all in scope-transform.ts)

- **`transformExpr`**: new `windowFunction` case rebuilding `function` (args mapped
  through `transformExpr`) and `window` via two new helpers
  `transformWindowDefinition` / `transformFrameBound` (partitionBy, orderBy, frame
  start/end bound `value` expressions). Substitution/descend are THREADED through
  (the ticket's recommended option), not a bare clone — see "Semantic widening" below.
- **`rebuildSelect`**: now emits `withClause: cloneWithClause(sel.withClause)` — a
  pure structural clone; CTE bodies go through `cloneQueryExpr`, NOT the substitution
  descend (preserves the documented "CTE bodies are never rewritten" contract while
  severing sharing). Doc comments on `rebuildSelect`/`mapQueryExprUniform` updated
  from "preserved structurally" to "cloned without substitution".
- **`mapQueryExprUniform`**: the IUD branch's `{ ...query }` replaced with
  `cloneDmlStmt` — a pure structural deep clone (no substitution threading; the
  scope-aware view-mutation descent rejects DML subqueries before reaching it).
  New helpers: `cloneWithClause`, `cloneResultColumns`, `cloneContextValues`,
  `cloneUpsertClause`, `cloneDmlStmt`. Covered per ast.ts shapes: `table` identifier,
  `withClause`, insert `columns`/`source`/`upsertClauses` (conflictTarget array,
  assignments, where), update `assignments`, `where`, `returning`, `contextValues`,
  `schemaPath` arrays.

## Validation performed

- New spec `packages/quereus/test/schema/clone-expr-isolation.spec.ts` — 7 cases, all
  passing. Each pins BOTH directions: rewriter hit the clone (`changed === true`) AND
  source `expressionToString` byte-stable. Channels: table-rename through CTE body,
  column-rename through CTE body, column-rename through window function
  (partition by / order by), table-rename through INSERT-RETURNING, table-rename
  through UPDATE-RETURNING, column-rename through UPDATE assignments, column-rename
  through an ON CONFLICT DO UPDATE upsert clause (parser accepts it in expression
  position; the rewriter does descend into it). All four ticket-pinned cases failed
  before the fix (reproduced during fix stage).
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- `yarn test` (full workspace suite) — green: 5561 passing / 9 pending (pre-existing
  pendings) in quereus, all other packages pass. This includes the test/logic/93.x
  view-mutation suites that exercise the substitution callers whose semantics must
  not shift.

## Points for the reviewer

1. **Semantic widening in the window case (deliberate, per ticket recommendation).**
   Before: window args/partitionBy/orderBy/frame bounds passed through the
   substitution callers SHARED and UNSUBSTITUTED (a latent view-mutation substitution
   gap). Now: substitution threads through them like any sibling projection scalar.
   All 93.x logic tests pass, but I did not find/verify a logic test specifically
   covering "window function over view columns inside a mutation subquery" — coverage
   of the widened path may be thin. Ticket fallback if a regression surfaces: revert
   that case to a pure structural clone and file a backlog ticket for the substitution
   gap.
2. **Known residual sharing (judged out of scope — rewriters never mutate these).**
   `tags?: Record<string, SqlValue>` on DML stmts is reference-copied by the spread;
   `compound.existence` / join `existence` readonly arrays likewise; `loc` objects
   shared everywhere by `{ ...expr }` spreads (never mutated). And `FunctionSource`
   sits in the Expression union but has no `transformExpr` case — in scalar position
   it would share `name`/`args` via the default branch. The parser doesn't produce
   FunctionSource in scalar expression position (it's handled in FROM via
   `rebuildFrom`), but it is the one Expression-union member with nested expressions
   still not deep-cloned.
3. **No changes to rename-rewriter.ts / schema-differ.ts / constraint-builder.ts** —
   the ticket's analysis (confirmed) is that the in-place contract is sound once the
   clone is truly deep; only the clone needed fixing.
4. The new clone helpers are module-private; only `rebuildSelect` and
   `mapQueryExprUniform` call them. `cloneWithClause` is also reached through
   `transformScopedQuery` → `rebuildSelect` (the scope-aware path), which now clones
   CTE bodies instead of sharing them — same documented no-rewrite contract, verify
   you agree that's behavior-preserving (93.x suites say yes).
