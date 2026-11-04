---
description: The main SQL test suite now compares very large whole numbers exactly, so a wrong answer from the engine fails the test instead of passing because both sides were rounded to the same value.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic-exact-json.ts                     # new: parseExactJson, canonicalNumbers
  - packages/quereus/test/logic-exact-json.spec.ts                # new: the reproduction
  - packages/quereus/test/logic.spec.ts                           # three call sites; normalizeBigInts removed
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic  # line 137: wrong expectation corrected
  - packages/quereus/test/logic/03.6-type-system.sqllogic         # comment only
  - packages/quereus/test/logic/03.5-tvf.sqllogic                 # comment only
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic # comment only
  - packages/quereus/test/numeric-canonical.spec.ts               # comment only
  - packages/quereus/test/README.md                               # expected-result format
---

## What changed

`.sqllogic` expected results used to be rounded to a double on both sides of the comparison: the expected side by `JSON.parse`, the actual side by `normalizeBigInts`. A correct result and an off-by-one result could land on the same value, so the test could not fail. This hid a wrong expectation in `104-emit-mutation-kills.sqllogic:137`, which said `9007199254740994 - 1` is `9007199254740992`. It is now corrected to `9007199254740993`.

Two functions in the new `test/logic-exact-json.ts` replace that:

- `parseExactJson(text)` uses the `context.source` reviver argument of `JSON.parse` to read each number's literal text. An integer-shaped literal states an exact integer. A literal with a fraction or an exponent states a double.
- `canonicalNumbers(value)` gives each numeric value one representation, and is applied to both the actual and expected rows. A safe-range bigint becomes a number. An integer-valued number outside the safe range becomes the bigint with that double's exact value.

The comparison remains numeric rather than type-sensitive: an expected `9007199254740992` matches either the bigint or the double with that value. An expected `9007199254740993` matches no double, because no double holds it. `-- params:` lines also go through `parseExactJson`, so a large bind value is no longer rounded before reaching the engine.

## Differences from the plan

- Both functions are typed with `unknown` rather than the `any` in the ticket's sketch, per AGENTS.md. The params call site casts with `as any[]`, since `currentParams` is declared that way and `logic.spec.ts` already disables the rule.
- Two stale comments the plan did not list were also rewritten: `28.2-set-op-branch-types.sqllogic:142` and `numeric-canonical.spec.ts:8-9`. The latter named the removed function.
- The `28.2` comment still justifies its `cast(v as text)` assertions, because the harness cannot tell a bigint from a double of the same value. The `03.5` and `03.6` assertions are unchanged too, as planned.

## Tests added

`test/logic-exact-json.spec.ts`, comparing `canonicalNumbers(parseExactJson(text))` with `canonicalNumbers([actual])`:

| expected text | actual | verifies |
| --- | --- | --- |
| `[9007199254740993]` | `9007199254740992n` | rejected: the reproduction, an off-by-one that rounds to the same double |
| `[9007199254740993]` | `2 ** 53` (double) | rejected: no double holds 2^53 + 1 |
| `[9007199254740993]` | `9007199254740993n` | matches: exact bigint past 2^53 |
| `[9007199254740992]` | `2 ** 53` (double) | matches: double whose exact value is the literal |
| `[1e308]` | `1e308` (double) | matches: exponent literal stays a double |
| `[5]` | `5n` | matches: safe-range bigint against a small literal |
| `["9007199254740993"]` | `"9007199254740993"` | matches: digit strings stay strings |

## Validation run

- `yarn workspace @quereus/quereus run lint`: exit 0. `--listFiles` confirms the new files are in the type-check pass.
- `yarn test`: exit 0, with 11014 passing and 26 pending in `packages/quereus`, and no failures in any workspace.
- Logic spec with `QUEREUS_TEST_STORE=true`: exit 0, 370 passing, 7 pending.
- File 104 with the old value temporarily restored at line 137 fails with `Actual: {"r":"9007199254740993"}` and `Expected: {"r":"9007199254740992"}`. With the correction it passes, which also confirms line 141 and the rest of the file on the memory backend. The store run above covers that file on the store backend.
- Mutation check on the new spec, with each change reverted afterwards: replacing the reader with plain `JSON.parse` fails 3 tests; making `canonicalNumbers` always round bigints fails 2.

## Known gaps for the reviewer

- **The `-- params:` path has no test.** No corpus file binds a value past 2^53 (per the plan's grep; not repeated here), so the change to that call site is exercised only with safe-range values. It calls the same reader as expected results.
- **Node version requirement.** The reader throws on a Node without `context.source`, rather than falling back to rounding. Verified on Node 24.2 only. The repo has no `engines` field, `.nvmrc` or `.github/workflows`, so nothing pins or enforces a version. An older Node would fail every `.sqllogic` assertion with that error message.
- **Downstream harnesses.** The README now states the literal rules and the need for source-preserving parsing. Harnesses on plain `JSON.parse` keep passing but get no exact checking; this was reasoned from the corrected line 137 rounding to the same double, not run against a downstream harness.
- **Blobs.** `canonicalNumbers` keeps the old object recursion, so a `Uint8Array` still becomes a plain object keyed by index. This is documented in its JSDoc and covered only by the existing corpus.
- **Numbers inside JSON-typed columns and failure-message rendering** were checked by inspection and the corpus passing, not by a dedicated test.

`tickets/fix/bug-text-coercion-in-arithmetic-and-aggregates.md` names this ticket as a prereq and says the harness cannot tell a correct large result from a wrong one. That sentence becomes out of date once this lands. I left it for that ticket's agent, because the ticket is not part of this work.
