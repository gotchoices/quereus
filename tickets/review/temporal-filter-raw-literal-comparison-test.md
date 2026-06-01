description: Review the new sqllogic cases pinning that pushed-down temporal (DATE/DATETIME/TIME) filter literals are compared RAW (BINARY, no canonicalization) against the stored canonical value.
files:
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic (new dt_filter / d_filter / t_filter sections appended at EOF)
  - packages/quereus/test/logic.spec.ts (sqllogic runner; describe is `File: 98-temporal-edge-cases.sqllogic`)
  - packages/quereus/src/planner/building/expression.ts (insertCrossTypeCoercion — Cast inserted ONLY for numeric↔textual operand pairs)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts (getLiteralValue — returns the raw AST literal)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts (seek-key value path; reads the literal raw via getLiteralValue)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts (tryTemporalComparison — TIMESPAN-only; DATE/DATETIME/TIME fall through)
  - packages/quereus/src/runtime/emit/binary.ts (calls tryTemporalComparison, else BINARY_COLLATION compare)
----

# Review: RAW comparison of pushed-down temporal filter literals (test pin)

## What was implemented

A purely **additive** change to `packages/quereus/test/logic/98-temporal-edge-cases.sqllogic`
(+71 lines, appended after the existing `dt_offset` section at EOF, no source code touched).
Three new sections pin the **no-canonicalization** contract for the temporal filter/read path:

- **`dt_filter` (DATETIME)** — the core case, mirroring the Lamina-side differential assertion:
  - `ts = '2017-07-14T02:40:00Z'` → `c=0` (Z-suffixed literal denoting the same instant as the
    bare-stored row does **not** match — raw byte compare).
  - `ts = '2017-07-14T03:40:00+01:00'` → `c=0` (offset literal of the same instant as row 1;
    also does not match row 2, whose bare value shares the `...03:40:00` prefix but lacks `+01:00`).
  - `ts = '2017-07-14T02:40:00'` → `c=1` (bare canonical literal matches exactly).
  - `ts < '2017-07-14T02:40:00Z'` → returns the bare row only (raw lexicographic order: bare
    `...02:40:00` is a proper prefix of `...02:40:00Z`, so it sorts below; row 2 `...03:40:00` excluded).
- **`d_filter` (DATE)** and **`t_filter` (TIME)** — the same contract on the identical
  `isTemporal → BINARY` compare path: a Z-suffixed/datetime literal → `c=0`, the bare canonical
  literal → `c=1`.

## Why this matters (intent of the pin)

The contract was previously **source-verified only** (a manual reading of the three sites listed
in `files:`). Today no test fails if a future planner change inserts temporal-literal
canonicalization — e.g. a temporal arm added to `insertCrossTypeCoercion`, or canonicalizing the
seek-key value in `rule-sargable-range-rewrite`. Such a change would silently make a non-canonical
literal start *matching*. These cases bind it: any such regression flips the `c=0` expectations to
`c=1` and fails the file. This is the native-side half of Lamina's
`lamina-temporal-filter-differential-native-pin` backlog item (Lamina replays this corpus and
compares against native Quereus; it relies on native also comparing raw).

The pin is **meaningful, not trivially-passing**: `c=0` vs `c=1` is exactly the discriminator —
canonicalization would make the Z-suffixed literal return `c=1`, so the test genuinely guards the
behavior rather than asserting a tautology.

## Validation performed

Both backends pass (filter path differs between memory and store):

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "98-temporal-edge-cases"
```

- Memory mode: **1 passing** (76ms).
- Store mode (`QUEREUS_TEST_STORE=true`): **1 passing** (248ms).

Every expected output was confirmed against actual engine behavior by running the focused file
(not hand-derived and left unverified). No expectation was edited to force a pass — they matched
on the first run, which confirms the no-canonicalization contract has **not** drifted.

## Suggested review focus / known gaps (honest)

- **Coverage breadth.** DATETIME exercises `=` (3 cases) plus one `<` range; DATE and TIME exercise
  only `=` (match + no-match). This matches the ticket scope and the same `isTemporal → BINARY` path,
  but a reviewer wanting belt-and-suspenders could add `>`/`>=`/`<=`/`BETWEEN` range cases for DATE/TIME.
  Judgment call: likely redundant since all three types share one compare path; flagging rather than papering over.
- **Indirect dependency on stored-value canonicalization.** These cases assume stored values
  canonicalize to the bare form (`'2017-07-14T02:40:00'`, `'2024-01-15'`, `'10:30:00'`), which the
  pre-existing `dt_canon`/`d_canon`/`t_canon` sections already pin. If stored-value canonicalization
  ever regressed, the `c=1` expectations here could pass for the wrong reason — but `*_canon` guards
  that independently, so the coupling is acceptable.
- **Lexicographic-range reasoning.** The `ts < '...Z'` case relies on bare being a strict byte-prefix
  of the Z-suffixed literal. Confirmed empirically by the passing run; worth a second read since it is
  the one assertion driven by ordering rather than equality.
- **No source change to confirm.** This ticket only adds tests against current behavior; the three
  source sites in `files:` were read but not modified. The reviewer may want to spot-check
  `insertCrossTypeCoercion` / `getLiteralValue` / `tryTemporalComparison` to confirm the prose
  description still matches the code at review time.

## No pre-existing failures encountered

The focused suite was clean in both backends; no `tickets/.pre-existing-error.md` was written.
