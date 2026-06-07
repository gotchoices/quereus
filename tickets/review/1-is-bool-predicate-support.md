description: Review of `expr IS [NOT] TRUE/FALSE` boolean-test predicate support. Four new postfix unary operators (`IS TRUE`, `IS NOT TRUE`, `IS FALSE`, `IS NOT FALSE`) now parse, type (BOOLEAN non-null), evaluate (3VL via isTruthy), round-trip, and compile in partial-index WHERE clauses. Implemented as unary operators mirroring `IS [NOT] NULL`. The `existence-probe-richer-forms` ticket builds on top.
prereq:
files: packages/quereus/src/parser/parser.ts (isPredicate, ~L1336-1365), packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode.generateType, ~L38-46), packages/quereus/src/runtime/emit/unary.ts (emitUnaryOp, four new arms ~L43-73), packages/quereus/src/emit/ast-stringify.ts (POSTFIX_IS_OPERATORS ~L323, unary case ~L233), packages/quereus/src/vtab/memory/utils/predicate.ts (compileUnary, four new arms ~L161-182), packages/quereus/test/logic/03.9-is-bool-predicate.sqllogic (new), packages/quereus/test/parser.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts
----

## What landed

All four boolean-test forms are now an end-to-end SQL feature. Each is a
`UnaryExpr.operator` string (`'IS TRUE'`, `'IS NOT TRUE'`, `'IS FALSE'`,
`'IS NOT FALSE'`), exactly paralleling the existing `IS NULL` / `IS NOT NULL`
unary operators. No AST/builder/visitor changes were needed (the builder builds
any unary operator generically; walkers descend `unary` structurally).

Semantics (SQLite-compatible, **total — never NULL**); operand truthiness uses
the engine's `isTruthy`:

| operator       | operand NULL | operand non-NULL |
|----------------|--------------|------------------|
| `IS TRUE`      | `false`      | `isTruthy(v)`    |
| `IS NOT TRUE`  | `true`       | `!isTruthy(v)`   |
| `IS FALSE`     | `false`      | `!isTruthy(v)`   |
| `IS NOT FALSE` | `true`       | `isTruthy(v)`    |

### Source changes (5 sites)

- **Parser** `isNull()` → renamed `isPredicate()` (call site in `notExpression()`
  updated). After `IS [NOT]` it now also matches `TRUE`/`FALSE`; the generic
  `IS <expr>` backtrack (`this.current--`, plus extra `--` for `IS NOT`) is
  preserved unchanged.
- **`UnaryOpNode.generateType`** — four operators added to the `IS NULL` arm →
  `BOOLEAN_TYPE`, `nullable = false`.
- **`emitUnaryOp`** — four `run` arms implementing the table via `isTruthy`.
  (Also: renamed the unused first param `ctx` → `_ctx` across **all** ten
  run-closures in this file — see "Reviewer flags" below.)
- **`ast-stringify.ts`** — new `POSTFIX_IS_OPERATORS` set drives postfix
  rendering (`<expr> is not true`, lower-cased) for all six IS-postfix operators.
- **`compileUnary`** (partial-index predicate compiler) — four arms via the
  file's `predicateTruthy` helper, so `IS [NOT] TRUE/FALSE` works in a partial
  index instead of throwing `Unsupported unary operator`.

## Validation performed (all green)

- `yarn typecheck` (tsc --noEmit): clean.
- `yarn lint` (eslint): clean.
- `yarn test` (full memory suite): **5098 passing, 9 pending, 0 failing** — no
  regressions.

### Tests added

- **`test/logic/03.9-is-bool-predicate.sqllogic`** (new; modeled on
  `03.8-not-precedence.sqllogic`):
  - 4×3 **totality matrix** ({IS TRUE, IS NOT TRUE, IS FALSE, IS NOT FALSE} ×
    {true, false, null}) as aliased scalar selects — pins NULL totality.
  - **non-boolean truthiness** via `isTruthy`: `'1'`→true, `'0'`→false,
    `'abc'`→false, `2`→true, `0 IS FALSE`→true. These are the JS-truthiness
    regression catchers (`'abc'` and `'0'` are JS-truthy but SQL-falsey).
  - column-reference filters over a `flag any null` table for all four forms.
  - **precedence**: `not flag is true` ≡ `not (flag is true)` ≡ `flag is not
    true` (prefix NOT binds above the IS predicate).
  - **partial-index smoke**: builds indexes whose WHERE is each of the four
    operators (exercises `compileUnary`), then re-queries for correctness.
  - **CHECK constraint**: `check (c is not false)` admits true+null, rejects
    false — confirms check-extraction/assertion-classifier don't throw on the
    new operator string and the constraint is enforced by general evaluation.
- **`test/parser.spec.ts`**: positive parses for all four; `not 1 is true` →
  `NOT(IS TRUE(1))`; general `1 is x` still throws (backtrack preserved).
- **`test/emit-roundtrip.spec.ts`**: round-trip for all four forms.

## Reviewer flags (known gaps / things to scrutinize)

- **Broadened `_ctx` rename in `runtime/emit/unary.ts`.** Editing the file
  surfaced LSP "unused param" diagnostics on the *pre-existing* `ctx` params too
  (none of the run-closures use it). To satisfy AGENTS.md ("prefix unused
  arguments with `_`") and keep the file uniform, I renamed `ctx` → `_ctx` in
  **all ten** arms, not just my four. This is slightly wider than the feature
  diff — confirm the churn is acceptable (it's cosmetic; param names don't
  affect the `InstructionRun` type).
- **Partial-index smoke proves "compiles + correct results," not "index is
  consulted."** Like the existing `10.5.1-partial-indexes.sqllogic`, the test
  asserts result correctness (a full scan also satisfies it); it does not assert
  the planner actually uses the partial index. The four `compileUnary` arms are
  therefore covered at *build* time (no throw) and via result correctness, not
  via an index-usage assertion. If you want a tighter check, add a plan
  assertion that the partial index is selected.
- **Boolean storage not asserted.** `feat.flag` is `any` and stores literal
  `true`/`false`; tests select `id`, never `flag`, so whether the engine stores
  boolean vs coerced 1/0 is not pinned. Semantics hold either way through
  `isTruthy`, but if you care about the storage class, add a `select flag`
  assertion.
- **Normalizer / check-extraction / assertion-classifier** were verified by
  code-reading (non-NOT unary recurses operand and returns unchanged; the others
  use fall-through switches that don't throw on unknown operators) plus the
  full-suite pass plus the CHECK smoke — not by dedicated unit tests targeting
  each analysis with the new operators.
- **Out of scope (unchanged):** the binary `IS` path. General `a IS b` remains
  unsupported and `x IS y` still errors (asserted). No store-specific path is
  touched (pure-expression), so `test:store` was intentionally not run per the
  ticket.

## Suggested review focus

- Re-derive the 4×3 totality table against the emitter arms and the sqllogic
  expected rows — the `IS NOT TRUE`/`IS NOT FALSE` NULL→true flip is the subtle
  part.
- Confirm `compileUnary`'s use of `predicateTruthy` (null→null) maps to the same
  truth table as the emitter's `operand === null ? … : isTruthy(…)`.
- Sanity-check the parser backtrack: `IS NOT TRUE` consumes both `IS` and `NOT`;
  the failure path for a non-NULL/TRUE/FALSE token must un-consume both.
