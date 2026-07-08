description: Review a batch of small core-engine cleanups — a hoisted precedence table, a JSON-comparison cache, a lexer slice optimization, removed `any` casts, latch timeout diagnostics, and a fix for named parameters bound to null.
files:
  - packages/quereus/src/emit/ast-stringify.ts (needsParens precedence/associativity now module constants ~343)
  - packages/quereus/src/util/comparison.ts (objectCanonicalString WeakMap cache ~183; sqlValuesEqual ~505)
  - packages/quereus/src/parser/lexer.ts (TokenLiteral type ~169; run-slice string/identifiers; number() dead try/catch removed)
  - packages/quereus/src/parser/parser.ts (statementSupportsWithClause type guard ~4850; tokenLiteralValue helper; unary-minus cast ~4051)
  - packages/quereus/src/util/latches.ts (optional timeout/deadlock diagnostics)
  - packages/quereus/src/core/statement.ts (validateParameterTypes presence check ~642)
  - packages/quereus/test/parameter-array-scalar.spec.ts (null-binding tests)
----

## What this ticket did

Batched low-severity core cleanups from the core review. Six of the seven items
landed here; two larger items were split into their own `implement/` tickets (see
**Split off** below). Build, lint, and the full quereus test suite (`yarn test`)
pass — 6475 passing, 9 pending. Two new tests added (both green).

### Items landed

- **`needsParens` precedence table hoisted** (`emit/ast-stringify.ts`). The
  per-call `precedence` record and the associative-ops array are now module-level
  constants (`BINARY_OPERATOR_PRECEDENCE`, `ASSOCIATIVE_BINARY_OPERATORS`), built
  once. Added the previously-missing `<>` (mirrors `!=`, precedence 3) and the
  binary distinct-from `IS` / `IS NOT` (precedence 3, equality group) so they
  parenthesize correctly instead of defaulting to 0. **No existing operator was
  renumbered** — emitted SQL for prior operators is unchanged.

- **OBJECT-class comparison no longer re-stringifies** (`util/comparison.ts`). Added
  an `objectCanonicalString` helper backed by a `WeakMap<object,string>` so a sort
  serializes each JSON value once instead of O(log n) times. `sqlValuesEqual`'s
  object path now routes through the same helper (DRY, shares the cache).

- **Lexer builds lexemes by slice, not char-by-char** (`parser/lexer.ts`). `string`
  and `doubleQuotedIdentifier` take each unbroken run in a single `substring`;
  `backtickIdentifier` and `bracketIdentifier` (no escape) are single slices.
  `advance()` still walks each char so line/column tracking is unchanged. Removed
  the dead outer `try/catch` around `parseInt` in `number()` (an all-digit lexeme
  never makes `parseInt` throw or return NaN).

- **`any` removed** (`parser/lexer.ts`, `parser/parser.ts`). `Token.literal` is now
  a `TokenLiteral = string | number | bigint | Uint8Array` union; `addToken`'s
  param typed to match. The two `(stmt as any).withClause` casts are gone —
  `statementSupportsWithClause` is now a type predicate narrowing to the four
  with-clause-bearing statement types. Value-token literal reads that the union
  surfaced were fixed via a small `tokenLiteralValue(token): SqlValue` helper and
  one `as string` / `as number` at sites where the token type is already matched.

- **Latch timeout/deadlock diagnostics** (`util/latches.ts`). `acquire` takes an
  optional `timeoutMs`; when set and the predecessor does not release in time, it
  logs a warning naming the contended key, **releases its own queue slot so the
  queue is not wedged**, and rejects with `QuereusError(StatusCode.BUSY)`. Default
  (no timeout) preserves the original never-reject behavior. A module-level NOTE
  documents that the queue map is a process-global static shared across databases.

- **Named-param-bound-to-null fix** (`core/statement.ts`). The scalar-required-param
  guard resolved values with `boundArgs[key] ?? boundArgs[':'+key]`; a bare key
  bound to `null` fell through the `??` to the `:`-prefixed alternate. Now uses
  `Object.hasOwn`, so a bound `null` is honored.

## How to validate

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — full suite; 6475 passing.
- Targeted: `node packages/quereus/test-runner.mjs --reporter spec --grep "bound to null"`
  runs the two new parameter tests.

### Test emphasis / use cases

- **Null-binding regression** (`parameter-array-scalar.spec.ts`): the
  `honors a null bare binding rather than the :-prefixed alternate` test binds both
  `needle: null` and `':needle': [1,2]`; on the old `??` code it wrongly raised the
  array-valued-scalar MISMATCH, now it returns 0 rows with no error. This is the
  test that actually distinguishes old from new behavior.
- **Round-trip / stringify**: the `needsParens` change is exercised by the existing
  ast round-trip / canonical-DDL tests (all pass). Worth an extra adversarial look
  (see gaps).

## Known gaps / where to look hard (tests are a floor, not a ceiling)

- **`needsParens` `IS` / `IS NOT` / `<>` placement is a judgment call.** I put them
  at the equality precedence (3) to match `= == !=`. The table is the emitter's own
  round-trip scheme, not SQLite's exact grammar. All round-trip tests pass, but I
  did **not** find a test that specifically round-trips a binary distinct-from
  (`a IS b`, `a IS NOT b`) or `<>` nested inside another operator. If such a shape
  exists in the grammar, add a round-trip case; confirm `(a is b) = c` and
  `a and (b is not c)` re-parse to the same AST.
- **Lexer "byte-identical" claim rests on the suite, not a differential test.** I did
  not write a char-by-char-vs-slice differential harness. The run-slice refactor
  preserves `advance()` per-char walking, so positions and values should match, but
  a reviewer wanting certainty could fuzz strings with embedded newlines, doubled
  quotes at run boundaries, and unterminated-at-EOF inputs against a pre-change
  build.
- **Latch timeout path is dormant.** No caller passes `timeoutMs` yet, so the new
  reject/slot-release branch is not exercised by any test. It is opt-in and
  backward-compatible, but the slot-release-on-timeout logic is untested. If the
  reviewer wants coverage, a small unit test (two acquires on one key, second with a
  short timeout, first never releasing) would lock it.

## Review findings (tripwires noticed, parked in place)

- **OBJECT canonical form coordination** — `util/comparison.ts`
  `objectCanonicalString` uses `JSON.stringify` insertion-order output as
  "canonical". NOTE comment at the site asks to keep it in step with the
  `json-canonical-key-hashing` work if that defines a different canonical form.
  Parked as a code comment; not a defect today.
- **`Latches` process-global scope** — `util/latches.ts` NOTE documents that the
  queue map is a `static` shared across all `Database` instances; two databases with
  the same key contend. Diagnostics-only improvement landed here; the actual scoping
  is split to the `latches-database-scoping` implement ticket (referenced by that
  exact slug in the code comment).

## Split off (larger items, own `implement/` tickets)

- `database-materialized-views-decomposition` — the 3,655-line
  `core/database-materialized-views.ts` still needs the sibling-file decomposition.
  Pure mechanical, too bulky to combine safely with this batch.
- `latches-database-scoping` — scope the latch registry per-database instead of the
  process-global static. Non-trivial (public export + many static call sites); the
  diagnostics-only improvement already landed here.
