---
description: Make the main SQL test suite compare very large whole numbers exactly, so a wrong answer from the engine fails the test instead of passing because both sides were rounded to the same value.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic.spec.ts                      # normalizeBigInts (line 25), expected JSON.parse (line 707), params JSON.parse (line 785), comparison (line 723)
  - packages/quereus/test/logic-exact-json.ts                # new: the reader and the normalizer
  - packages/quereus/test/logic-exact-json.spec.ts           # new: the reproduction
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic  # line 137: wrong expectation to correct
  - packages/quereus/test/logic/03.6-type-system.sqllogic    # lines 390-393: comment describing the old rounding
  - packages/quereus/test/logic/03.5-tvf.sqllogic            # lines 102-103: comment describing the old rounding
  - packages/quereus/test/README.md                          # line 52: expected-result format
---

## Problem

`.sqllogic` files state expected results as JSON. Both sides of the comparison are rounded to a double before they are checked: the expected side by `JSON.parse`, the actual side by `normalizeBigInts` in `test/logic.spec.ts`. A correct result and an off-by-one result land on the same value, so an expectation above 2^53 - 1 cannot fail when the true value is not representable as a double.

This has already hidden a wrong expectation. `test/logic/104-emit-mutation-kills.sqllogic:137` says `select 9007199254740994 - 1` returns `9007199254740992`. The engine correctly returns `9007199254740993`, and the test passes at HEAD.

## Design

Compare exact mathematical values, using two small functions in a new `test/logic-exact-json.ts`. It is a separate module for the same reason as `logic-capabilities.ts`: importing `logic.spec.ts` would register the whole suite.

**The reader, `parseExactJson(text)`.** Calls `JSON.parse` with a reviver that uses the reviver's third argument, `context.source`, which holds the literal's original text. This is the standard "JSON.parse source text access" feature, so no hand-written JSON scanner is needed (AGENTS.md rules those out).

```ts
const INTEGER_LITERAL = /^-?\d+$/;

export function parseExactJson(text: string): any {
	return JSON.parse(text, (_key: string, value: any, context?: { source?: string }) => {
		if (typeof value !== 'number') return value;
		if (context?.source === undefined) {
			throw new Error('Exact .sqllogic number comparison needs JSON.parse source text access (context.source); upgrade Node.');
		}
		return INTEGER_LITERAL.test(context.source) && !Number.isSafeInteger(value) ? BigInt(context.source) : value;
	});
}
```

The rule this gives test authors: **an integer-shaped literal states an exact integer; a literal with a fraction or an exponent states a double.** So `9007199254740993` is exact, while `1e308` and `9007199254740993.0` are read as doubles. That is not a gap: such a literal is asking for the double nearest that text, the same as any other `JSON.parse` number.

**The normalizer, `canonicalNumbers(value)`.** Replaces `normalizeBigInts` and is applied to both the actual row and the expected row, so one numeric value has exactly one representation:

- a bigint in the safe-integer range becomes a number
- a number that is an integer outside the safe-integer range becomes a bigint, using `BigInt(number)`, which is that double's exact value
- everything else is unchanged; arrays and objects recurse exactly as `normalizeBigInts` does today

The comparison stays numeric rather than type-sensitive, as it is now: an expected `9007199254740994` matches either the bigint or the double with that exact value, since JSON cannot say which was meant and existing expectations (`03.7`, `07.5`) rely on it. `typeof` assertions in the corpus cover the distinction where it matters. An expected `9007199254740993` cannot match any double, because no double has that value.

**Call sites in `logic.spec.ts`.**

- line 707: `expectedResult = canonicalNumbers(parseExactJson(expectedJson))`
- line 723: `expect(canonicalNumbers(actualResult[i])).to.deep.equal(expectedResult[i], ...)`
- line 785: `currentParams = parseExactJson(paramsJson)`. Params had the same flaw: a large bind value was silently rounded before reaching the engine. No corpus file uses one today (grep of `-- params:` lines with 16+ digit numbers finds none), so this changes no current result.
- remove `normalizeBigInts`

The ticket's fallback idea, a loud error telling authors to use `cast(... as text)`, is dropped because exact comparison makes it unnecessary. Existing `cast(... as text)` assertions stay. They also pin text rendering and are still correct, and rewriting them gains nothing.

## Corpus audit (measured)

A temporary copy of the harness with this design ran the full corpus, then was deleted. Each file stops at its first failure.

- Memory backend: 376 passing, 1 failing (`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js <copy of logic.spec.ts> --reporter dot`, run from the repo root)
- Store backend (`QUEREUS_TEST_STORE=true`, same command): 369 passing, 1 failing
- `tsc -p tsconfig.test.json --noEmit` was clean with the reviver's optional third parameter

The one failure on both backends is `104-emit-mutation-kills.sqllogic:137`:

```
Actual: {"r":"9007199254740993"}
Expected: {"r":"9007199254740992"}
```

The engine is right, so the expectation changes to `9007199254740993`. Line 141 is the only later expectation in that file above 2^53 (`9007199254740993 * 2` = `18014398509481986`, correct by arithmetic, but not observed because the file stopped at 137), so re-run the file after the correction to confirm.

## Shared corpus

`test/logic/*.sqllogic` ships to other projects, whose harnesses reimplement parsing against `test/README.md`. A harness still using plain `JSON.parse` keeps passing: the corrected line 137 rounds to the same double as before. It just doesn't get exact checking until it adopts these rules, so the README must state them.

## Edge cases & interactions

- **Double result past 2^53, integer literal expected** (`03.6:430`, `07.5:34`, `03.7:9`): compares the double's exact value with the literal. Passed in the audit run; covered by a test below.
- **Exponent literal** (`1e308` at `07.5:77,80`): stays a double on the reader, and both sides then normalize to the same bigint. Passed in the audit run; covered by a test below.
- **Digits in strings and column names** (`{"9007199254740993 + 1":...}`, `{"v":"9007199254740993"}`): the reviver only acts on number values and never sees keys. Covered by a test below for strings; keys by inspection.
- **Negative zero** (`03.5:71` relies on chai telling `-0` from `0`): `-0` is a safe integer and passes through unchanged. Verified by that existing corpus line.
- **Safe-range bigint vs number**: `5n` normalizes to `5`. Covered by a test below.
- **Blobs**: `Uint8Array` results currently pass through the object branch of `normalizeBigInts`. Keep that recursion as is, so blob expectations don't change. Verified by the existing corpus.
- **Nested JSON values**: the reviver runs at every depth and the normalizer recurses, so numbers inside JSON-typed columns behave the same. By inspection.
- **Node without `context.source`**: the reviver throws rather than quietly falling back to rounding. The repo declares no `engines` version; this was verified on Node 24.2, the version in use here. By inspection.
- **Failure messages**: `safeJsonStringify` prints an unsafe bigint as a quoted string, as in the output above. Readable enough and not worth changing here. By inspection.
- **Store backend**: same results as memory in the audit run. Re-run per the TODO below, since the corrected line lets the rest of file 104 execute.

## Tests

One new spec, `test/logic-exact-json.spec.ts`, as the bug's reproduction at the lowest layer. The corrected corpus line alone would not catch the harness going back to rounding, because both sides would round together. Comparing `canonicalNumbers(parseExactJson(text))` with `canonicalNumbers(actual)`:

| expected text | actual | result |
| --- | --- | --- |
| `[9007199254740993]` | `9007199254740992n` | not equal (the reproduction) |
| `[9007199254740993]` | `9007199254740993n` | equal |
| `[9007199254740993]` | `9007199254740992` (double) | not equal |
| `[9007199254740992]` | `9007199254740992` (double) | equal |
| `[1e308]` | `1e308` (double) | equal |
| `[5]` | `5n` | equal |
| `["9007199254740993"]` | `"9007199254740993"` | equal, and still a string |

## TODO

- Add `test/logic-exact-json.ts` with `parseExactJson` and `canonicalNumbers`; give both JSDoc stating the literal rule above
- Add `test/logic-exact-json.spec.ts` with the table above
- Update `test/logic.spec.ts` at the three call sites and remove `normalizeBigInts`
- Correct `test/logic/104-emit-mutation-kills.sqllogic:137` to `9007199254740993`
- Rewrite the comments at `test/logic/03.6-type-system.sqllogic:390-393` and `test/logic/03.5-tvf.sqllogic:102-103`, which say the harness rounds; keep the assertions
- Add to `test/README.md` beside the `→` bullet at line 52: integer-shaped literals compare exactly, literals with a fraction or exponent state a double, and numeric comparison does not distinguish a bigint from a double of the same exact value. Note that downstream harnesses need source-preserving JSON parsing to get this
- Run from the repo root: `yarn workspace @quereus/quereus run lint`, `yarn test`, and the logic spec with `QUEREUS_TEST_STORE=true`; expect no `.sqllogic` failures on either backend
