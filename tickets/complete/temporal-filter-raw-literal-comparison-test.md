description: Pin in the sqllogic corpus that a pushed-down temporal (DATE/DATETIME/TIME) comparison literal is compared RAW (BINARY, no canonicalization) against the stored canonical value. Native-side half of Lamina's `lamina-temporal-filter-differential-native-pin`.
files:
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic (new dt_filter / d_filter / t_filter sections appended at EOF)
  - docs/datetime.md (documented the filter-literal raw-comparison contract — added in review)
  - packages/quereus/src/planner/building/expression.ts (insertCrossTypeCoercion — Cast inserted ONLY for numeric↔textual operand pairs)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts (getLiteralValue — returns the raw AST literal)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts (seek-key value path; reads the literal raw via getLiteralValue)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts (tryTemporalComparison — TIMESPAN-only; DATE/DATETIME/TIME fall through)
  - packages/quereus/src/runtime/emit/binary.ts (calls tryTemporalComparison, else BINARY_COLLATION compare)
----

# Complete: RAW comparison of pushed-down temporal filter literals (test pin)

## Summary

Purely additive `.sqllogic` change (+71 lines appended to `98-temporal-edge-cases.sqllogic`)
plus a docs clarification added during review. No engine source touched. Three new sections
(`dt_filter` DATETIME, `d_filter` DATE, `t_filter` TIME) pin the **no-canonicalization** contract
on the temporal filter/read path: a `Z`-suffixed or offset-bearing literal that denotes the same
instant as a bare-stored row does **not** match (raw BINARY compare), while the bare canonical
literal matches; a `<` range case pins the raw lexicographic ordering (bare form is a strict prefix
of the `Z`-suffixed form). This is the native-side half of Lamina's
`lamina-temporal-filter-differential-native-pin`, which replays this corpus against native Quereus.

## Review findings

### Scope checked

- **The implement diff first, with fresh eyes** — read the full `git show ea575f62` (test additions
  + ticket move) before the handoff prose.
- **Test correctness & meaningfulness** — confirmed the pin is a real discriminator (`c=0` vs `c=1`),
  not a tautology: canonicalization would flip the `c=0` expectations to `c=1`.
- **Source-claim accuracy** (the three sites the handoff describes but does not modify) — verified
  each against current code so the prose is honest:
  - `insertCrossTypeCoercion` (expression.ts:60-82) gates **only** on `isNumeric`/`isTextual` — a cast
    is synthesized solely for numeric↔textual pairs; a temporal operand never gets one. ✔
  - `getLiteralValue` (constraint-extractor.ts:858 and rule-sargable-range-rewrite.ts:139) returns the
    raw AST literal via `getSyncLiteral` — no parse/canonicalize. ✔
  - `tryTemporalComparison` (temporal-arithmetic.ts:376) is **TIMESPAN-only**; DATE/DATETIME/TIME fall
    through to the `BINARY_COLLATION` compare in binary.ts. ✔
- **Range/ordering reasoning** — re-derived the `ts < '...Z'` case by hand (bare `...02:40:00` is a
  proper byte-prefix of `...02:40:00Z`, so it sorts below → only row 1 returned, row 2 `...03:40:00`
  excluded). Matches the pinned output.
- **Path robustness** — the contract holds on both the residual-filter path (memory) and the
  pushed-down seek-key path (store, via the sargable-range rewrite + constraint extractor), so the
  pin is valid regardless of which path the planner picks. Confirmed by both backends passing.
- **Docs** — read `docs/datetime.md` (the canonicalization doc the change is adjacent to) and every
  source file the change references.
- **Lint + tests** — both run, both clean.

### Findings & disposition

- **MINOR (fixed inline): docs gap.** `docs/datetime.md:43-52` documented stored-value
  canonicalization with the line "so that equal instants compare equal regardless of how they were
  written" — true for stored values but **misleading for filter literals**, which are compared raw.
  A reader would reasonably (and wrongly) expect `WHERE ts = '2017-07-14T02:40:00Z'` to match a row
  storing that instant. This is exactly the surprising behavior the new test pins, and the change
  should have closed the doc gap. Fixed: added a paragraph to `docs/datetime.md` spelling out the
  raw-comparison contract for predicate literals (incl. range ordering) and cross-referencing the
  `dt_filter`/`d_filter`/`t_filter` cases.

- **Considered, not acted on (judgment call): DATE/TIME range coverage.** DATETIME exercises `=`
  (3 cases) + one `<`; DATE/TIME exercise only `=`. The implementer flagged this. Confirmed all three
  types share the identical `isTemporal → BINARY` compare path *and* the same raw `getLiteralValue`
  seek-key path, so additional `>`/`<`/`BETWEEN` cases for DATE/TIME would be belt-and-suspenders
  redundancy over a path the DATETIME `<` case already pins. Not added — defensible coverage, not a
  defect.

- **No bugs, no correctness issues, no type-safety / cleanup / resource concerns** — the change is
  test-data + comments only; nothing to refactor. Empty by virtue of scope, stated explicitly rather
  than silently.

- **No major findings → no new fix/plan/backlog ticket spawned.**

### Validation (re-run during review)

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "98-temporal-edge-cases"
```

- Memory mode: **1 passing** (76ms).
- Store mode (`QUEREUS_TEST_STORE=true`): **1 passing** (232ms).
- `yarn workspace @quereus/quereus run lint`: **exit 0, clean.**

No `tickets/.pre-existing-error.md` written — both backends clean.
