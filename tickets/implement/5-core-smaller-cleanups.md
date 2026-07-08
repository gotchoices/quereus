description: A grab-bag of small code-quality and micro-performance cleanups in the core engine — hoisting a table out of a hot loop, removing dead code, replacing untyped casts, and fixing one parameter-binding edge case around null.
files:
  - packages/quereus/src/emit/ast-stringify.ts (needsParens precedence table ~341)
  - packages/quereus/src/util/comparison.ts (OBJECT comparison stringify-per-compare)
  - packages/quereus/src/parser/lexer.ts (char-by-char lexeme build, dead parseInt try/catch)
  - packages/quereus/src/parser/*.ts (Token.literal?: any; (stmt as any).withClause casts)
  - packages/quereus/src/util/latches.ts (process-global static keyed by string)
  - packages/quereus/src/core/database-materialized-views.ts (3,462-line file needing decomposition)
  - packages/quereus/src/core/statement.ts (validateParameterTypes named-param ?? fallback ~644)
difficulty: medium
----

## Problem

A collection of independent low-severity cleanliness/performance items found in the
core review. Each is small and self-contained; they are batched into one ticket to
avoid ticket sprawl. Address each bullet; a couple are larger and may be split off
into their own follow-up (noted below).

## Items

- **`needsParens` rebuilds its precedence table per call.** In
  `emit/ast-stringify.ts` (`needsParens`, ~341), the `precedence` record literal is
  re-created for every binary node visited — hot during canonical-DDL / body-hash
  stringification. Hoist it (and the associativity data) to module-level constants.
  While there, the table **omits `<>` and `IS`** operators — add them so their
  parenthesization is correct rather than defaulting to precedence 0.

- **OBJECT comparison JSON.stringifies both sides on every compare.** The
  OBJECT/JSON storage-class comparison path (`util/comparison.ts`) calls
  `JSON.stringify` on both operands per comparison, which is expensive inside a
  sort (O(n log n) stringifications). Avoid re-stringifying the same value
  repeatedly — e.g. compare structurally, or cache the canonical string per value.
  (Coordinate with the canonical-JSON work in `json-canonical-key-hashing` so the
  two do not diverge on what "canonical" means.)

- **Lexer builds lexemes char-by-char.** `parser/lexer.ts` accumulates lexeme
  strings one character at a time even in the common no-escape case, where it could
  slice from the start position to the terminator in one operation. Convert the
  no-escape case to a single slice. Also remove the **dead `parseInt` try/catch**
  the lexer still carries.

- **`any` violations (no-`any` rule).** `Token.literal?: any` should be given a
  proper union type. The two `(stmt as any).withClause` casts in the parser should
  be replaced with correctly typed access. See AGENTS.md "No `any`" rule.

- **`Latches` is a process-global static keyed by string.** `util/latches.ts` holds
  its lock queues in a `static` Map shared across *all* `Database` instances, keyed
  only by a string, with no timeout and no diagnostics. Two independent databases
  using the same key string contend on the same latch. At minimum add timeout /
  deadlock diagnostics; better, scope the latch registry to a database (or an owner)
  rather than the process. This is the larger of the items — if scoping proves
  non-trivial, split it into its own ticket and keep the diagnostics-only improvement here.

- **`database-materialized-views.ts` is 3,462 lines.** Its sibling `database-*.ts`
  files were decomposed into smaller single-purpose modules; this one still needs
  the same treatment. This is a mechanical-but-large refactor — if it does not fit
  in one agent run alongside the other bullets, split it into a dedicated ticket
  (it has no logic change, so it is low-risk but bulky).

- **`validateParameterTypes` named-param `??` fallback misfires on legitimate
  `null` bindings.** In `core/statement.ts` (`validateParameterTypes`, ~644) the
  lookup `this.boundArgs[key] ?? this.boundArgs[':'+key]` uses `??`, so a parameter
  *legitimately bound to `null`* falls through to the `:`-prefixed alternate key
  instead of using the bound `null`. Use a presence check (`in` / `Object.hasOwn`)
  to distinguish "bound to null" from "not bound", so a genuine `null` binding is
  respected.

## Edge cases

- The `needsParens` change must not alter emitted SQL for existing operators —
  only add the missing `<>`/`IS` handling and move the table; round-trip tests
  should still pass.
- The `null`-binding fix changes observable behavior for `:param` bound to `null` —
  add a test: bind a named parameter to `null` and confirm the correct value is used.
- The lexer slice change must produce byte-identical tokens to the char-by-char path
  (including edge cases at input boundaries).

## TODO

- Hoist `needsParens` precedence/associativity tables to module constants; add `<>` and `IS`.
- Cache/avoid repeated `JSON.stringify` in the OBJECT comparison path (align with `json-canonical-key-hashing`).
- Convert lexer no-escape lexeme accumulation to a single slice; delete the dead `parseInt` try/catch.
- Replace `Token.literal?: any` with a proper union; remove the two `(stmt as any).withClause` casts.
- Add timeout/diagnostics to `Latches` (and consider database-scoping the registry; split to own ticket if non-trivial).
- Decompose `database-materialized-views.ts` into smaller modules (split to own ticket if it does not fit one run).
- Fix the `validateParameterTypes` named-param fallback to use presence check instead of `??`; add a null-binding test.
- Run build + lint + tests.
