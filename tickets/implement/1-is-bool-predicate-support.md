description: Add end-to-end SQL support for the `expr IS [NOT] TRUE` / `expr IS [NOT] FALSE` boolean-test predicates (SQLite-compatible). Today these do not parse at all — `isNull()` only wires `IS NULL` / `IS NOT NULL`, and the runtime has no evaluator for them. This ticket lands them as four unary operators so they parse, type, evaluate (3VL), and round-trip; the existence-probe rule extension (`existence-probe-richer-forms`) builds on top.
prereq:
files: packages/quereus/src/parser/parser.ts (isNull, ~L1334-1351), packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode.generateType, ~L33-51), packages/quereus/src/runtime/emit/unary.ts (emitUnaryOp switch), packages/quereus/src/emit/ast-stringify.ts (unary case, ~L225-239), packages/quereus/src/vtab/memory/utils/predicate.ts (compileUnary, ~L148-189), packages/quereus/src/util/comparison.ts (isTruthy), packages/quereus/test/logic/ (new .sqllogic)
----

## Why this ticket exists

The parent plan ticket assumed `flag is true` etc. already have an AST/plan
representation that just needs recognizing in the optimizer. Research disproved
that:

- **Parser** (`parser.ts` `isNull()`): after `IS [NOT]` it only accepts `NULL`.
  Anything else (`TRUE`/`FALSE`/any expr) backtracks, leaving the `IS` token
  unconsumed → a hard parse error. Verified empirically: `select * from t where
  f is true` ⇒ `Expected statement type … got 'is'`. So `IS TRUE` / `IS NOT
  TRUE` / `IS FALSE` / `IS NOT FALSE` are **not a supported language form today**.
- **Runtime** (`runtime/emit/binary.ts` `emitBinaryOp`): the `IS` / `IS NOT`
  binary operators throw `Unsupported binary operator`. `BinaryOpNode.generateType`
  knows their *type* (boolean, non-null) and a few internal analyses
  (`fd-utils`, memory `predicate.ts`) read a binary `IS … NULL` shape, but no
  user-reachable path evaluates a binary `IS`.

So general `a IS b` is also unsupported; this ticket scopes **only** the
boolean-test forms `IS [NOT] TRUE/FALSE`, which is what the probe work needs and
is a clean, standalone SQL feature.

## Representation decision (settled)

Represent each form as a **unary postfix operator**, mirroring the existing
`IS NULL` / `IS NOT NULL` unary operators exactly. Four new `UnaryExpr.operator`
string values:

| SQL              | `UnaryExpr.operator` | result type        |
|------------------|----------------------|--------------------|
| `x IS TRUE`      | `IS TRUE`            | BOOLEAN, NOT NULL  |
| `x IS NOT TRUE`  | `IS NOT TRUE`        | BOOLEAN, NOT NULL  |
| `x IS FALSE`     | `IS FALSE`           | BOOLEAN, NOT NULL  |
| `x IS NOT FALSE` | `IS NOT FALSE`       | BOOLEAN, NOT NULL  |

Rationale for unary-not-binary:

- `AST.UnaryExpr.operator` is a free `string`; no enum to extend.
- The expression builder (`building/expression.ts` `case 'unary'`) already builds
  any unary operator generically as `new UnaryOpNode(scope, expr, operand)` — no
  builder change needed.
- The runtime already has a unary dispatch (`emit/unary.ts`) and the precedent of
  `IS NULL` / `IS NOT NULL` postfix unary operators. A binary `IS` would instead
  require teaching `emitBinaryOp` a brand-new path.
- Every generic AST walker (`visitor.ts`, `scope-transform.ts`,
  `rename-rewriter.ts`, `select-aggregates.ts`, fingerprinting) already descends
  `unary` structurally, so the new operators ride along for free.

## Semantics (SQL three-valued logic, SQLite-compatible)

Operand truthiness uses the engine's `isTruthy` (`util/comparison.ts`) — the same
predicate `FilterNode` / `NOT` / logical ops use — so non-boolean operands behave
consistently (e.g. `'1' IS TRUE` ⇒ true, `'abc' IS TRUE` ⇒ false, `0 IS FALSE` ⇒
true). These predicates **never return NULL**:

| operator        | operand NULL | operand non-NULL          |
|-----------------|--------------|---------------------------|
| `IS TRUE`       | `false`      | `isTruthy(v)`             |
| `IS NOT TRUE`   | `true`       | `!isTruthy(v)`            |
| `IS FALSE`      | `false`      | `!isTruthy(v)`            |
| `IS NOT FALSE`  | `true`       | `isTruthy(v)`             |

Note `x IS NOT TRUE` ≡ `NOT (x IS TRUE)` and `x IS NOT FALSE` ≡ `NOT (x IS
FALSE)` — the NULL row flips into the "NOT" bucket, which is exactly why these are
total (never NULL).

## Implementation surface

- **Parser** (`isNull()`): after the `IS [NOT]` match, in addition to the existing
  `NULL` branch, accept `TokenType.TRUE` and `TokenType.FALSE`, emitting the
  corresponding unary operator from the table above. Preserve the existing
  backtrack (`this.current--`, plus the extra `--` when `IS NOT`) for the
  "neither NULL nor TRUE/FALSE" case. The lexer already tokenizes `TRUE`/`FALSE`
  (`TokenType.TRUE`/`FALSE`). Update the method doc comment to name the new forms;
  optionally rename `isNull` → `isPredicate` (keep the call site in
  `notExpression()` in sync).
- **`UnaryOpNode.generateType`** (`scalar.ts`): add the four operators alongside
  the `IS NULL` / `IS NOT NULL` case → `logicalType = BOOLEAN_TYPE`, `nullable =
  false`.
- **`emitUnaryOp`** (`runtime/emit/unary.ts`): add four `case` arms implementing
  the semantics table via `isTruthy`. Set a matching `note`.
- **`ast-stringify.ts`** (`case 'unary'`): treat the four operators as postfix
  (same branch as `IS NULL` / `IS NOT NULL`) so `astToString` round-trips them as
  `<expr> is true` etc. (lower-cased, matching existing style).
- **`compileUnary`** (`vtab/memory/utils/predicate.ts`): add the four operators so
  `IS [NOT] TRUE/FALSE` is usable in a **partial-index WHERE** rather than
  throwing `Unsupported unary operator`. Use the file's `predicateTruthy` helper
  with the same NULL handling as the table above. (Today it throws a clear error,
  so this is a completeness fix, not a correctness bug — but landing it with the
  feature keeps the operator set uniform.)

## Edge cases & interactions

- **NULL operand totality.** `null IS TRUE` ⇒ false, `null IS NOT TRUE` ⇒ true,
  `null IS FALSE` ⇒ false, `null IS NOT FALSE` ⇒ true. Assert all four; these are
  the cases that distinguish `IS [NOT] TRUE/FALSE` from `= true/false` (which
  returns NULL on a NULL operand).
- **Non-boolean operand truthiness.** Integers, reals, text, blobs must route
  through `isTruthy`, NOT JS truthiness — `'0' IS TRUE` ⇒ false, `2 IS TRUE` ⇒
  true, `'abc' IS FALSE` ⇒ true (non-numeric text is falsey, matching the rest of
  the engine). Cover at least one text and one numeric case so a regression to JS
  truthiness is caught.
- **`NOT` precedence.** `not f is true` must parse as `NOT (f IS TRUE)` (the `IS`
  predicate binds tighter than prefix `NOT`, same as `IS NULL`). Add a parse/eval
  case so precedence doesn't silently invert.
- **Parser backtrack preserved.** `x IS y` (general non-NULL, non-bool `IS`) must
  still produce the *same* error as today (unsupported) — confirm the
  `TRUE`/`FALSE` additions don't accidentally consume tokens for the generic-`IS`
  path. `x IS NOT z` likewise. `x IS NULL` / `x IS NOT NULL` unchanged.
- **Round-trip.** `astToString(parse("… where f is not true"))` re-parses to an
  equivalent AST (drive through the existing ast-stringify round-trip test
  harness if one exists, else a focused assertion).
- **Normalizer pass-through.** `normalizePredicate` (`predicate-normalizer.ts`)
  has no special case for these (they're non-`NOT` unary), so it recurses the
  operand and returns the node unchanged — confirm it does not wrap/mangle a bare
  `f IS TRUE` conjunct (the downstream probe rule depends on this).
- **CHECK / constraint extraction.** `check-extraction.ts` and
  `assertion-classifier.ts` switch on a fixed operator set; the new operators fall
  through to "residual / not extracted" — acceptable (a `CHECK (c IS TRUE)` is
  enforced by general evaluation, just not specially analyzed). Confirm no path
  throws on the new operator string.
- **Store path.** Behavior is pure-expression, so `yarn test` (memory vtab)
  covers it; no store-specific path is touched. Do not run `test:store` for this
  ticket.

## TODO

- Parser: extend `isNull()` to emit `IS [NOT] TRUE/FALSE` unary operators;
  update doc comment.
- `UnaryOpNode.generateType`: BOOLEAN/non-null for the four operators.
- `emitUnaryOp`: four evaluator arms via `isTruthy` per the semantics table.
- `ast-stringify.ts`: postfix rendering for the four operators.
- `compileUnary` (partial-index predicate): four arms via `predicateTruthy`.
- Tests (primary: a new `test/logic/*.sqllogic` modeled on
  `test/logic/03.8-not-precedence.sqllogic`):
  - `IS TRUE` / `IS NOT TRUE` / `IS FALSE` / `IS NOT FALSE` over true / false /
    NULL operands (the 4×3 totality matrix).
  - non-boolean operands (`'1'`, `0`, `'abc'`, `2`) exercising `isTruthy`.
  - `not f is true` precedence case.
  - a partial-index using `where flag is true` (smoke: index builds + filters).
- Build + typecheck + lint + `yarn test` green; stream output with `tee`.
