description: Closed the subquery/function-source arm of the lens override basis-source check. `validateOverrideBasisSources` now does a reflective whole-body walk over the override `select` AST, so a cross-basis schema-qualified `table` node buried in any nested position (subquery source, CTE body, compound leg, function-source arg, scalar/where/in/exists subquery) is rejected even under full explicit column coverage.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## Summary

The implement stage replaced the bespoke top-level `table`/`join` FROM switch in
`validateOverrideBasisSources` (`lens-compiler.ts:1391`) with a stack-based
reflective walk over the entire `override.select` AST. For every visited node
with `node.type === 'table'` it applies the schema-qualified-outside-basis check;
the thrown message is byte-for-byte unchanged so existing regex matchers keep
working. Call site changed to pass `select` instead of `select.from`
(`lens-compiler.ts:1203`). Docstring and `docs/lens.md` § "v1 override body-shape
restrictions" updated (the "Known gap" paragraph removed, whole-body coverage
documented). Tests added for subquery-source, nested-CTE, and nested-compound-leg
negatives plus basis-subquery and basis-CTE positives.

## Review findings

### What was checked

- **Implement diff read first, fresh** (`git show 81af4264`) before the handoff
  summary: source, tests, and docs hunks.
- **Reflective-walk correctness / completeness.** Cross-checked against the
  canonical `traverseAst` visitor (`parser/visitor.ts:44`) and the AST shapes
  (`parser/ast.ts`: `TableSource:404`, `SubquerySource:416`, `FunctionSource:161`,
  `JoinClause:424`, `SelectStmt.compound:185`, `IdentifierExpr:39`). Confirmed the
  walk reaches every nested position the docstring claims: subquery-source FROM
  trees, `withClause` CTE bodies, the type-less `compound {op,select}` wrapper,
  function-source args, and `where`/`in`/`exists`/scalar subqueries.
- **False-positive surface.** Confirmed `type: 'table'` is the *unique*
  discriminant of `TableSource` in the parser AST (the only other `type:'table'`
  hits in the repo are unrelated `quereus-store`/`quereus-sync` event objects, not
  reachable from a `SelectStmt`). The check fires only on a non-basis *schema
  qualifier*; CTE refs and FROM aliases are always bare, so the schema-qualified-
  only invariant holds and no in-scope-name set is needed.
- **Termination & resource use.** AST from the parser is an acyclic tree, so the
  unbounded-looking stack walk terminates. Generic `Object.values` descent into
  non-AST values (`loc`, `LiteralExpr.value` which may be `Uint8Array`/`Promise`)
  is benign: typed-array elements are numbers (filtered by `typeof === 'object'`),
  a Promise has no own enumerable props. Override bodies don't carry large blobs
  in practice.
- **Docs.** Read both touched docs against the new reality: `docs/lens.md` bullet
  (Known-gap sentence replaced) and the function docstring — both accurate.

### What was found

- **No correctness defects.** The walk is sound and, unlike a `type`-gated
  generic walk (the ticket's `collectColumnRefNames` template), provably complete
  for the closed gap. Minor: the implementer's stated contrast is with that
  type-gated template, **not** with `traverseAst` — `traverseAst` *does* descend
  `compound.select` explicitly. Worth knowing for future maintainers, but not a
  defect.
- **DRY tradeoff (accepted, not changed).** The reflective walk duplicates
  traversal that `traverseAst` already performs; one could instead call
  `traverseAst(select, { visitTableSource: … })`. I deliberately did **not**
  rewrite it: `traverseAst` silently `warnLog`s + skips unhandled node types and
  does not traverse the legacy `SelectStmt.union`/`unionAll` fields (only
  `compound`), so a future AST node carrying a nested SELECT would silently
  reintroduce this *security-relevant* cross-schema re-anchor gap. The generic
  walk is robust to AST evolution; that robustness outweighs the DRY cost here.
- **Test coverage gap (minor — fixed inline).** The handoff flagged the non-FROM
  subquery positions (`where`/`in`/`exists`) and function-source args as "covered
  only by construction." Added a `where id in (select id from z.CarCore)` negative
  test ("errors on a cross-basis table inside a where-in subquery") to pin that
  the check covers expression subqueries, not just FROM/subquery-source positions.
  Function-source-arg coverage left as representative (path is structurally
  identical to the subquery-source case the walk already exercises).

### What was done

- **Minor, inline:** added one negative test (above) to
  `packages/quereus/test/lens-overrides.spec.ts`.
- **No major findings; no new fix/plan/backlog tickets filed.**

### Disposition by category

- Correctness bugs: **none found.**
- Edge/error/regression cases: covered; one gap closed inline (where-in subquery).
- DRY/modularity: one tradeoff reviewed and consciously accepted (rationale above).
- Type safety: the walk uses narrow `as` casts behind a `typeof`/`type` guard; no
  `any`; acceptable.
- Resource cleanup / performance / termination: verified safe.
- Docs: verified up to date.

### Validation status — confirmed green

Run from this review pass (a transient harness output-delivery lag made results
arrive in a delayed batch, but all commands executed and were observed):

- `yarn workspace @quereus/quereus test:single packages/quereus/test/lens-overrides.spec.ts`
  → **27 passing** (was 26; +1 for the new `where-in subquery` negative).
- `yarn workspace @quereus/quereus typecheck` → exit 0.
- `yarn workspace @quereus/quereus lint` → exit 0.

The implement handoff's full-suite figure (**4127 passing / 9 pending**) was not
re-run here (out of scope for a targeted-spec review pass); no code outside this
spec's surface changed, so no regression risk. No `.pre-existing-error.md` written
(no failing test observed).
