description: Prefix `NOT` now binds above every predicate (IN, BETWEEN, LIKE, IS [NOT] NULL, comparison) — fixed by inserting a dedicated `notExpression()` precedence level between `logicalAnd` and `isNull` and removing `NOT` from arithmetic `unary()`. Stringifier `unaryBodyNeedsParens` extracted so future emitter changes have a single hook. Regression coverage at parser, direct-DDL CHECK, and declarative-schema layers. Closes github.com/gotchoices/quereus/issues/22.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Summary

Parser previously matched prefix `NOT` inside `unary()` alongside `-`/`+`/`~`,
so `not x in (...)`, `not x between …`, `not x like …`, `not a is null`,
and `not 0 = 5` all bound to the *primary*, not the *predicate*. Issue
#22 surfaced semantically through the `declare schema` + `apply schema`
round-trip: stringify→re-parse re-associated `not Color in (select Code
from Block)` to `(not Color) in (select Code from Block)`, which then
flagged every row as a CHECK violation.

Implementation:
- Parser: new right-recursive `notExpression()` between `logicalAnd()` and
  `isNull()`. `logicalAnd()` descends into it; `unary()` no longer
  consumes `TokenType.NOT`. (`parser.ts:1195-1215, 1476-1486`)
- Stringifier: extracted `unaryBodyNeedsParens(expr)` returning true only
  when `expr.expr.type === 'binary'`. Under the new precedence chain
  every other body shape (`in`, `between`, `unary`, `exists`, `cast`,
  `collate`, primary literals/columns) is self-delimiting and
  round-trips cleanly. (`ast-stringify.ts:180-191, 274-281`)
- Regression tests: pure parser (`02-filters.sqllogic`), direct-DDL CHECK
  (`40.2-check-extras.sqllogic`), and declare/apply round-trip
  (`50-declarative-schema.sqllogic`).

## Review findings

### Checked

- **Parser correctness against SQLite precedence.** Trace through new
  call chain `logicalXorOr → logicalAnd → notExpression → isNull →
  equality → comparison(IN/BETWEEN/LIKE/comparison) → term → … → unary →
  primary`. NOT now sits below AND and above all predicates, which
  matches SQLite's documented order. The right-recursive
  `notExpression` cleanly handles `not not p` via plain recursion.
  Manually traced golden-path and edge inputs (`not x in (…)`,
  `not x between 1 and 3`, `not 'a' like 'b%'`, `not null is null`,
  `not 0 = 5`, `not not 1`, `not exists (…)`, `not cast(x as int)`,
  `not a collate nocase`, `not -a + b`); every shape produces the
  expected AST and round-trips through the stringifier.
- **Audit of all remaining `TokenType.NOT` usages in parser.ts.** The
  five surviving call sites are all postfix or DDL contexts (`IS NOT
  NULL` at line 1225; `NOT IN`/`NOT BETWEEN`/`NOT LIKE` inside
  `comparison()` at lines 1265/1271; `NOT NULL` / `NOT DEFERRABLE` in
  DDL paths). None can now compete with prefix NOT for the same token.
- **Planner/runtime safety of `UnaryExpr{NOT, *}` over predicate bodies.**
  Spawned a focused exploration of the planner (`buildExpression`,
  `UnaryOpNode`, `predicate-normalizer.pushNotDown`, runtime emit
  `unary.ts`). All dispatch is generic: `buildExpression` recurses on
  any inner expression type, `UnaryOpNode` resolves NOT to a boolean
  result regardless of operand shape (preserves nullability),
  `isTruthy` correctly preserves three-valued logic, and the
  `predicate-normalizer` already special-cases `BetweenNode` while
  falling back to a generic `UnaryOpNode` wrap for everything else.
  Nothing assumes the inner expression is comparison-only — so the new
  ASTs (`UnaryExpr{NOT, InExpr}`, `UnaryExpr{NOT, BetweenExpr}`,
  `UnaryExpr{NOT, BinaryExpr{LIKE}}`, etc.) plan and execute
  identically to the previously-built `comparison()`-side
  variants.
- **Stringifier round-trip under new precedence.** Confirmed
  by-construction that every non-`binary` body re-parses to the same
  AST under the post-fix grammar. The implementer's choice to keep
  `unaryBodyNeedsParens` minimal (rather than the defensive list in the
  source ticket) is correct under the current parser and avoids
  ~6 fixture diffs. Future-proofing this assumption is exactly what
  sibling `plan-ast-stringify-roundtrip-property-test` (issue #23) is
  for — flagged in "Follow-ups" below, no inline ticket needed.
- **Test coverage.** Five predicate shapes at the parser layer,
  direct-DDL CHECK path, and the declarative round-trip that originally
  triggered #22. Each correctly fails on `main` (parser bug) and passes
  with the fix.
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` → exit 0.
  `yarn workspace @quereus/quereus run test` → 3219 passing, 0 failing.
- **Docs.** Searched `docs/` for a precedence table or expression
  grammar that mentions NOT; none exists, so nothing to update.

### Found

- **Style nit (not fixed):** the new tests in
  `40.2-check-extras.sqllogic` declare `Block` and `T` with `using
  memory`, while the rest of that file lets the test framework pick
  the default storage module. Six other instances of `using memory`
  exist in the whole `test/logic/` tree, so this is unusual but
  harmless. Left as-is — removing it risks store-mode behavior the
  implementer may have been working around, and `yarn test:store` was
  not run as part of this ticket (slow + irrelevant to a parser fix).
  Worth a brief follow-up if anyone runs `test:store` end-to-end.
- **Minor stylistic choice (not fixed):** the unary branch in
  `ast-stringify.ts:188` was changed from
  `${expr.operator.toLowerCase()} ${exprStr}` to a hardcoded
  `not ${exprStr}`. Since the branch only fires when
  `expr.operator.toUpperCase() === 'NOT'`, the behavior is identical;
  the hardcode reads cleaner but tightens coupling. No action.

### Not found / explicitly not done

- **No major findings** — no new ticket(s) filed by this review.
- **`yarn test:store` not run.** Deferred per ticket scope; this is a
  parser/stringifier-only change and the store path is irrelevant.
- **Pre-existing monorepo build failure** in
  `packages/quereus-isolation/.../isolation-module.ts:564` is unchanged
  from `main` (the implementer verified). Out of scope.
- **Cartesian `NOT × predicate` matrix and the property-test for
  stringify round-trip** were already split off as sibling tickets
  (`plan-prefix-not-precedence-test-matrix`,
  `plan-ast-stringify-roundtrip-property-test`,
  `plan-declarative-schema-semantic-equivalence-harness`) and remain
  the right home for that work.

## Follow-ups (already filed, not re-opened by this review)

- `plan-ast-stringify-roundtrip-property-test` — property-based
  stringify→re-parse coverage, would lock down the
  `unaryBodyNeedsParens` minimality assumption structurally.
- `plan-prefix-not-precedence-test-matrix` — full Cartesian matrix of
  `NOT × {IN, BETWEEN, LIKE, IS [NOT] NULL, comparison, EXISTS, CASE,
  function-call}`.
- `plan-declarative-schema-semantic-equivalence-harness` — generalised
  direct-DDL vs declare/apply parity harness for CHECK / DEFAULT /
  generated-column expressions.
