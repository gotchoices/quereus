description: |
  `expr IS [NOT] TRUE/FALSE` boolean-test predicate support. Four postfix unary operators
  (`IS TRUE`, `IS NOT TRUE`, `IS FALSE`, `IS NOT FALSE`) parse, type (BOOLEAN non-null),
  evaluate (total / SQLite-compatible 3VL via `isTruthy`), round-trip, and compile in
  partial-index WHERE clauses — implemented as unary operators mirroring `IS [NOT] NULL`.
  Reviewed and accepted; one doc gap fixed inline, one optimization opportunity filed to
  backlog.
files:
  - packages/quereus/src/parser/parser.ts                          # isNull → isPredicate; matches TRUE/FALSE after IS [NOT], backtrack preserved (~L1340)
  - packages/quereus/src/planner/nodes/scalar.ts                   # UnaryOpNode.generateType: four ops → BOOLEAN_TYPE, nullable=false (~L38)
  - packages/quereus/src/runtime/emit/unary.ts                     # emitUnaryOp: four run arms via isTruthy (~L43)
  - packages/quereus/src/emit/ast-stringify.ts                     # POSTFIX_IS_OPERATORS set drives postfix rendering (~L323)
  - packages/quereus/src/vtab/memory/utils/predicate.ts            # compileUnary: four arms via predicateTruthy (~L161)
  - packages/quereus/docs/sql.md                                   # §4.2 IS-predicate family documented (review-added)
  - packages/quereus/test/logic/03.9-is-bool-predicate.sqllogic    # totality matrix, truthiness, column filters, precedence, partial-index, CHECK
  - packages/quereus/test/parser.spec.ts                           # positive parses + NOT precedence + backtrack-still-throws
  - packages/quereus/test/emit-roundtrip.spec.ts                   # round-trip for all four forms
----

## What shipped

Each boolean-test form is a `UnaryExpr.operator` string (`'IS TRUE'`, `'IS NOT TRUE'`,
`'IS FALSE'`, `'IS NOT FALSE'`), exactly paralleling the existing `IS [NOT] NULL` unary
operators — no AST/builder/visitor changes needed (the builder builds any unary operator
generically; walkers descend `unary` structurally). Semantics are **total** (never NULL);
operand truthiness routes through the engine's `isTruthy`:

| operator       | operand NULL | operand non-NULL |
|----------------|--------------|------------------|
| `IS TRUE`      | `false`      | `isTruthy(v)`    |
| `IS NOT TRUE`  | `true`       | `!isTruthy(v)`   |
| `IS FALSE`     | `false`      | `!isTruthy(v)`   |
| `IS NOT FALSE` | `true`       | `isTruthy(v)`    |

Five source sites: parser (`isNull` → `isPredicate`, matches TRUE/FALSE after `IS [NOT]`,
the generic `IS <expr>` backtrack preserved), `UnaryOpNode.generateType`, `emitUnaryOp`,
`ast-stringify` (`POSTFIX_IS_OPERATORS`), and `compileUnary` (partial-index predicate
compiler). Full mechanism detail is in the implement commit `2ae251aa`.

## Review findings

**Verdict: accepted.** The implementation is correct, minimal, and consistent with the
existing `IS [NOT] NULL` machinery. One minor doc gap fixed inline; one optimization
opportunity filed to backlog. No correctness defects found.

### Checked — and clean

- **Emitter truth table (the load-bearing claim).** Re-derived all 4×3 cells against the
  `emitUnaryOp` arms; the `IS NOT TRUE` / `IS NOT FALSE` NULL→true flip is correct.
- **Emitter ↔ partial-index parity.** `compileUnary`'s `predicateTruthy` (NULL→`null`,
  else `isTruthy`) maps to exactly the same truth table as the emitter's `operand === null
  ? … : isTruthy(…)` for all four ops. Confirmed equivalent.
- **Parser backtrack.** `IS NOT <non-keyword>` un-consumes both `IS` and `NOT`
  (`if (isNot) this.current--; this.current--;`); `1 is x` still throws (asserted). The
  TRUE/FALSE additions sit before the backtrack and never steal tokens from the generic
  `IS` path.
- **Type.** `generateType` returns `BOOLEAN_TYPE`, `nullable=false` — matches totality.
- **Round-trip parenthesization.** Reuses the `IS NULL` postfix path; `unaryBodyNeedsParens`
  parenthesizes binary operands, so complex operands re-parse identically.
- **Downstream analysis passes — all degrade gracefully (verified by reading, not just
  "doesn't throw"):**
  - `constraint-extractor.ts` — the new ops are not `IS [NOT] NULL`, so they fall to the
    **residual predicate** (correct, just not pushed down). A test already pins this shape
    for `NOT` (`constraint-extractor.spec.ts:417`).
  - `check-extraction.ts` / `assertion-classifier.ts` `negateAst` — the new ops hit the
    **wrap-in-NOT fallback**, which is a *semantically faithful* negation (the NOT unary is
    evaluated generically by the emitter); they are simply not consumed as domain
    contributions. `recognizeNegatedGuard` returns `undefined` (bails safely).
  - `best-access-plan.ts` `ConstraintOp` is a closed union the new ops never reach (residual).
- **Tests are real, not vacuous.** Confirmed the `.sqllogic` harness auto-discovers the new
  file (`logic.spec.ts:460` `readdirSync(...).filter(endsWith('.sqllogic'))`), and that the
  CHECK test's `-- error: CHECK constraint failed` is a genuine assertion — the harness
  (`executeExpectingError`, `logic.spec.ts:564/723`) **throws if the SQL succeeds**, so the
  constraint is provably enforced, not a masked no-op.

### Found and fixed inline (minor)

- **`docs/sql.md` §4.2 was inaccurate and stale.** The "Other Operators" entry described
  `is` / `is not` as a general binary identity test ("Tests if values are identical
  (including NULL)") — but binary `a IS b` is **not supported** and errors; only the postfix
  `IS [NOT] NULL/TRUE/FALSE` predicates exist. Replaced that entry with an accurate
  **IS Predicates** subsection covering all six postfix forms, the totality table, the
  `isTruthy` routing note, and an explicit "general binary `a is b` is not supported" line.

### Found and deferred (filed)

- **No constraint pushdown / index seek / selectivity for the boolean tests.** They evaluate
  as residual filters only. This is a *missed optimization, not a bug* (results are always
  correct) and is consistent with the pre-existing treatment of `NOT col`. The partial-index
  smoke test asserts result correctness but not index *usage*. Filed as
  `tickets/backlog/known/4-is-bool-predicate-constraint-pushdown.md` (includes the
  index-usage plan-assertion the test is missing).

### Noted, no action

- **`_ctx` rename churn** across all ten `emitUnaryOp` run-closures (not just the four new
  ones) is cosmetic and lint-driven; param names don't affect the `InstructionRun` type.
  Acceptable.
- **Boolean storage class not asserted** — `flag any` stores `true`/`false`; tests select
  `id` not `flag`. Semantics hold either way through `isTruthy` (`isTruthy(true)` ==
  `isTruthy(1)`), so no coverage gap of consequence.

## Validation

- `yarn lint` (eslint): clean (exit 0).
- `yarn typecheck` (tsc --noEmit): clean (exit 0).
- `yarn test` (full monorepo): **quereus 5098 passing / 0 failing** plus all other
  workspaces green (sync 317 + 163, store/isolation/etc.). No regressions. (The
  `failingKv.iterate` line in the sync log is a deliberate fault-injection inside a passing
  test, unrelated to this change.)
- `test:store` not run — pure-expression change, no store-specific path touched (per the
  original ticket).
