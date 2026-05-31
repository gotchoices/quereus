description: Review the close of the subquery/function-source arm of the lens override basis-source check. `validateOverrideBasisSources` was rewritten from a shallow top-level `table`/`join` FROM walk into a reflective whole-body walk over the override `select` AST, so a cross-basis `table` node buried in a subquery source, CTE body, compound leg, function-source arg, or scalar/where/in/exists subquery is now rejected even under full explicit column coverage (no gap-fill to trip the old basis-reachability error).
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## What changed

`validateOverrideBasisSources` (`lens-compiler.ts:1384`) previously walked only
top-level `table`/`join` FROM nodes; its `default` arm treated `subquerySource` /
`functionSource` as opaque. A full-coverage override whose FROM was a subquery
naming a *different* existing schema (`from (select * from z.CarCore)`) deployed
silently and re-anchored the body off its declared `over y` basis.

The fix replaces the bespoke `table`/`join` switch with a **reflective stack walk
over the entire `override.select` AST**. For every visited node with
`node.type === 'table'` it applies the existing schema-qualified-outside-basis
check; the thrown message is **byte-for-byte unchanged** so the established
matcher (`/outside the declared basis|references basis relation 'z/i`) and any
external matchers keep working.

- Call site changed from `validateOverrideBasisSources(select.from, …)` to
  `validateOverrideBasisSources(select, …)` (`lens-compiler.ts:1203`).
- Docstring rewritten: dropped the `KNOWN GAP` paragraph; documents the
  whole-body coverage and the schema-qualified-only invariant that makes CTE
  scope tracking unnecessary.
- `docs/lens.md` § "v1 override body-shape restrictions" (the "Cross-basis FROM
  source" bullet, ~line 120): the "**Known gap:**" sentence was replaced with a
  statement that the check now walks the whole body.

### Key design decision the reviewer should scrutinize first

The walk **descends into every nested non-null object/array, NOT only nodes that
carry a `type` discriminant.** This deliberately diverges from the ticket's
suggested template (`collectColumnRefNames`, `lens-compiler.ts:1800`), which
gates descent on `'type' in value`. Reason discovered during implementation:
several AST containers that hold nested SELECTs are **plain wrappers without a
`type` field** — most importantly `compound` (`{ op, select }`, see
`parser.ts:2234`) and `orderBy` clauses (`{ expr, direction, nulls }`). A
`type`-gated walk would silently skip cross-basis tables nested under them, which
would have reintroduced the very gap being closed. The generic descent makes the
walk *provably complete* (it cannot miss any reachable node).

Why this is safe (no false positives): the check fires **only** on
`node.type === 'table'` (the unique discriminant of `AST.TableSource`) carrying
an explicit, non-basis **schema qualifier**. CTE references and FROM aliases are
always *bare* (SQL has no `schema.cte` form) and the compiler resolves a bare
FROM table to the basis, so a bare name is always basis-or-CTE — never
cross-basis. No in-scope-name set is needed.

## How to validate

Run the targeted spec and the lint/typecheck:

```
yarn workspace @quereus/quereus test:single packages/quereus/test/lens-overrides.spec.ts
yarn workspace @quereus/quereus lint
yarn workspace @quereus/quereus typecheck
```

State at handoff: **26 passing** in that spec; **typecheck + lint clean**; full
`yarn workspace @quereus/quereus test` suite **4127 passing / 9 pending** (no
regressions). The "Rule 'X' never fired" lines from property-planner are
pre-existing informational notices, not failures.

### Behaviors pinned by new tests (in the `cross-basis join` describe block)

Negative (must throw, matching `/outside the declared basis|references basis relation 'z/i`):
- subquery source naming `z.CarCore` under full coverage — the original repro;
- cross-basis table inside a nested CTE body
  (`from (with c as (select * from z.CarCore) select * from c) sub`);
- cross-basis table inside a nested **compound leg**
  (`from (select … from y.CarCore union all select … from z.CarCore) sub`) — the
  exact case a `type`-gated walk would have missed.

Positive (must still deploy; both columns resolve to `source: 'override'`):
- subquery source over the *basis*: `from (select * from y.CarCore) sub`;
- CTE over the *basis* with a bare CTE reference
  (`from (with c as (select * from y.CarCore) select * from c) sub`) — pins that
  bare in-scope names are not mistaken for cross-basis relations.

Plus the pre-existing defect-5 guards (top-level cross-basis FROM, cross-basis
join leg) and the body-shape tests all still pass.

## Honest gaps / where to push

- **Test coverage of positions is representative, not exhaustive.** The reflective
  walk structurally covers cross-basis tables in *function-source arguments*
  (`some_tvf((select … from z.Foo))`), in `where` / `in` / `exists` / `having` /
  `groupBy` / `orderBy` subqueries, and in scalar projection subqueries — but only
  subquery-source, nested-CTE, and nested-compound positions have explicit tests.
  The `where`/`in`/`exists` and function-source-arg paths are exercised only by
  construction. A reviewer wanting belt-and-suspenders could add one
  `where id in (select id from z.CarCore)` negative and/or a function-source-arg
  negative; both should already throw.
- **Message wording is now slightly narrower than coverage.** The message still
  says "an override's FROM may only reference the declared basis", but the walk
  now also rejects cross-basis tables in non-FROM subquery positions
  (`where`/`in`/`exists`/projection). This was a deliberate choice (ticket
  instruction) to avoid churning the regex matchers; the dominant case remains a
  FROM source. Reviewer call whether the wording should be broadened later.
- **Generic descent touches non-AST objects** (`loc`, `LiteralExpr.value` which is
  `MaybePromise<SqlValue>` and could be a `Uint8Array`/Promise). This is safe —
  such values either aren't objects or have no `type === 'table'` and no nested
  AST — but it does mean a large BLOB literal in an override body would be
  iterated element-by-element via `Object.values`. Override view bodies don't
  carry big blobs in practice, so this was judged a non-issue; flagging it for a
  conscious sign-off. AST from the parser is a tree (no cycles), so the
  unbounded-looking stack walk terminates.
- **No CTE-name threading was added** (by design, see rationale above). If the
  reviewer disagrees with the schema-qualified-only invariant, that is the load-
  bearing assumption to challenge — but note SQL grammar admits no `schema.cte`
  form, so a CTE/alias reference cannot carry the schema qualifier the check keys
  on.

## Reference

- Implementation + docstring: `validateOverrideBasisSources`
  (`lens-compiler.ts:1367-1421` after the edit); call site `lens-compiler.ts:1203`.
- Template it intentionally diverges from: `collectColumnRefNames`
  (`lens-compiler.ts:1800`). Canonical traversal that confirmed the `type`-less
  `compound` wrapper: `traverseAst` (`parser/visitor.ts:74`).
- AST shapes: `TableSource`/`SubquerySource`/`FunctionSource`/`JoinClause`
  (`parser/ast.ts:401-433`), `SelectStmt.compound`/`withClause`
  (`parser/ast.ts:170-187`, `:548-566`), `IdentifierExpr.schema`
  (`parser/ast.ts:39-43`).
- Docs: `docs/lens.md` § "v1 override body-shape restrictions" (~line 114-120).
