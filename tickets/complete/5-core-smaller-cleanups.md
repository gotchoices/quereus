description: Reviewed and completed a batch of small core-engine cleanups — a hoisted precedence table, a JSON-comparison cache, a lexer slice optimization, removed `any` casts, latch timeout diagnostics, and a fix for named parameters bound to null.
files:
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/util/comparison.ts
  - packages/quereus/src/parser/lexer.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/util/latches.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/test/parameter-array-scalar.spec.ts
  - packages/quereus/test/emit-precedence.spec.ts (new `<>`→`!=` round-trip case)
  - packages/quereus/test/util/latches.spec.ts (new — latch serialization + timeout guard)
----

## What this ticket did

Adversarial review of the implement-stage batch of six low-severity core cleanups
(commit `1a983bce`). Read the full diff of all six source files with fresh eyes
before the handoff summary, verified each item, ran lint + the full quereus suite,
and closed two coverage gaps and one correctness/accuracy finding inline.

Final gate state: **lint clean**, **`yarn test` = 6479 passing, 9 pending, 0 failing**
(was 6475; +4 tests added this pass).

## Review findings

### Checked and verified sound (no change needed)

- **Named-param-bound-to-null fix** (`core/statement.ts:646`). The `Object.hasOwn`
  presence check correctly replaces the `?? boundArgs[':'+key]` fallthrough so a bare
  key bound to `null` is honored. This is a *bind-time diagnostic* guard only; the
  `??` pattern does not recur elsewhere in the resolution path (grepped). Correct.
- **Lexer run-slice refactor** (`parser/lexer.ts`). `advance()` still walks each char,
  so line/column tracking is byte-for-byte unchanged; only lexeme *accumulation* moved
  to `substring`. Walked the rewritten `doubleQuotedIdentifier` loop by hand across the
  no-escape, doubled-`""`, and unterminated-at-EOF cases — equivalent to the old
  char-by-char version. The removed `number()` `try/catch` is safe: the integer branch
  is reached only when the lexeme is a pure digit run (no hex/underscore lexing exists),
  so `parseInt(lexeme, 10)` never returns NaN or throws.
- **`any` removal** (`lexer.ts`, `parser.ts`). `TokenLiteral` union, `tokenLiteralValue`
  helper, and the `statementSupportsWithClause` type predicate are all sound; the two
  `(stmt as any).withClause` casts are correctly eliminated by the narrowing predicate.
- **Latch timeout/deadlock diagnostics** (`util/latches.ts`). The opt-in `timeoutMs`
  path is correct: on timeout it releases *its own* queue slot (so the queue behind it
  is not wedged) and rejects with `BUSY`. The `Promise<never>` timeout never settles on
  the fast path (timer cleared in `finally`), so there is no unhandled rejection. The
  slot-release sacrifices mutual exclusion against an abandoned predecessor — that is
  the intended deadlock-recovery tradeoff, documented at the site.
- **OBJECT canonical cache** (`util/comparison.ts`). `WeakMap`-by-identity cache and the
  DRY routing of `sqlValuesEqual`'s object path through the same helper are correct;
  structurally-equal distinct objects still compare/equate correctly (equal strings).

### Minor — fixed inline this pass

- **Dead precedence-table entries + misleading comment** (`emit/ast-stringify.ts`).
  The implement pass added `'<>': 3`, `'IS': 3`, `'IS NOT': 3` to
  `BINARY_OPERATOR_PRECEDENCE` with a comment claiming they "parenthesize correctly
  instead of defaulting to 0." Verified against the parser: `<>` is normalized to the
  `!=` token at lex time (`lexer.ts:427`) and stored as operator `'!='` (never `'<>'`);
  `IS` only ever forms *unary* nodes (`IS NULL` / `IS [NOT] TRUE|FALSE`) and otherwise
  backtracks (`parser.ts:1474` `isPredicate`) — there is **no binary distinct-from
  operator**. So all three keys are unreachable dead code and the comment described a
  path that cannot execute. **Removed the three entries and rewrote the comment** to
  state the actual parser behavior. No emitted-SQL change (confirmed: `(a <> b) = c`
  emits `a != b = c`, round-trip stable).

### Minor — test coverage added this pass (tests were a floor)

- **`<>`→`!=` precedence round-trip** (`test/emit-precedence.spec.ts`, in the existing
  dedicated precedence spec). Pins that `<>` is normalized to `!=` on emit and that a
  lower-precedence RHS (`a <> (b or c)`) keeps its parens through parse → stringify →
  parse. Closes the implementer's flagged "no test round-trips `<>`" gap. (The `IS` /
  `IS NOT` round-trip the handoff worried about is **not a real gap** — that grammar
  shape does not exist, per the finding above.)
- **Latch serialization + timeout guard** (`test/util/latches.spec.ts`, new file). The
  timeout branch was entirely untested (no caller passes `timeoutMs`). Three tests:
  default serialization order, `BUSY` rejection on timeout, and — the critical one —
  that a timed-out waiter releases its slot so a later waiter is not wedged.

### Tripwires noticed (parked in place, not filed as tickets)

- **OBJECT cache assumes value immutability** — `util/comparison.ts`. Added a `NOTE`
  at the cache: the canonical string is cached on first serialization and never
  invalidated, so mutating an OBJECT value in place after it has been compared would
  return a stale string. Fine today (OBJECT query values are treated as immutable);
  becomes work only if in-place mutation is ever introduced.
- **OBJECT canonical form coordination** — `util/comparison.ts` (pre-existing NOTE,
  left as-is). Uses `JSON.stringify` insertion-order output as canonical; keep in step
  with `json-canonical-key-hashing` if that lands a different canonical form.
- **`Latches` process-global scope** — `util/latches.ts` (pre-existing NOTE). The queue
  map is a `static` shared across all `Database` instances; the actual per-database
  scoping is split to the `latches-database-scoping` implement ticket.

### Docs

- No user-facing docs needed updating. Every item is internal (emit/parser/util/core
  internals); the null-binding change is a bugfix, not a documented behavior change, and
  the latch timeout is an internal opt-in param with no doc surface. Confirmed by reading
  the touched files — no doc references the changed internals.

### Not filed as tickets

- No **major** findings. No new `fix/`/`plan/`/`backlog/` tickets created from this
  review. The two larger split-off items (`database-materialized-views-decomposition`,
  `latches-database-scoping`) were already created by the implement pass and remain in
  `implement/`; nothing in this review changes their scope.

## How this was validated

- `yarn workspace @quereus/quereus run lint` — exit 0, clean (includes `tsc` typecheck
  of the new/edited spec files).
- `yarn workspace @quereus/quereus test` — 6479 passing, 9 pending, 0 failing.
- Targeted: `node test-runner.mjs --reporter spec --grep "Latches"` (3 passing);
  `--grep "ast-stringify AST round-trip"` and the emit-precedence spec (all green).

## End
