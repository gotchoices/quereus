---
description: The main SQL test suite now compares very large whole numbers exactly, so a wrong answer from the engine fails the test instead of passing because both sides were rounded to the same value.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic-exact-json.ts
  - packages/quereus/test/logic-exact-json.spec.ts
  - packages/quereus/test/logic.spec.ts
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic
  - packages/quereus/test/logic/03.6-type-system.sqllogic
  - packages/quereus/test/logic/03.5-tvf.sqllogic
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic
  - packages/quereus/test/numeric-canonical.spec.ts
  - packages/quereus/test/README.md
---

## What was built

`.sqllogic` expected results used to be rounded to a double on both sides of the comparison: the expected side by `JSON.parse`, the actual side by `normalizeBigInts`. A correct result and an off-by-one result could land on the same value, so the test could not fail. This hid a wrong expectation in `104-emit-mutation-kills.sqllogic:137`, which said `9007199254740994 - 1` is `9007199254740992`. It now says `9007199254740993`.

Two functions in `test/logic-exact-json.ts` replace the old path:

- `parseExactJson(text)` reads each number's literal text through the `context.source` reviver argument of `JSON.parse`. An integer-shaped literal states an exact integer. A literal with a fraction or an exponent states a double. `-- params:` lines use it too.
- `canonicalNumbers(value)` gives each numeric value one representation, on both the actual and expected rows. A safe-range bigint becomes a number. An integer-valued number outside the safe range becomes the bigint with that double's exact value.

The comparison is numeric rather than type-sensitive: `9007199254740992` matches either the bigint or the double with that value, and `9007199254740993` matches no double. `test/README.md` documents these rules as part of the corpus format.

## Review findings

Reviewed from `ticket(implement): debt-sqllogic-bigint-assertions-lossy`, reading the diff before the handoff.

**Fixed in this pass**

- `canonicalNumbers` assigned keys with `result[key] = ...`. An object key named `__proto__` was therefore dropped, and because expected rows now pass through the same function, it was dropped from both sides, so rows differing only under that key compared equal. A Node one-liner confirmed the assignment form drops the key and `Object.fromEntries` keeps it. The function now uses `Object.fromEntries`. No corpus file uses that key, so no test was added.
- `test/README.md` named `test/logic-exact-json.ts` without saying it is unpublished, although a downstream reader only has the tarball. It now says so.
- The README's claim that the corpus still passes under plain `JSON.parse` depends on no `-- params:` line binding past 2^53 - 1. A grep of the corpus confirms none does, and the sentence now states that condition, which also serves as the tripwire for a future params line.
- Cut the spec row matching a digit string against itself. Neither function has a string branch for it to exercise, and it would still pass if strings and bigints were conflated. The spec keeps 6 tests.

**Checked, no change needed**

- `-- params:` path (the handoff's untested gap): a temporary corpus file, since deleted, confirmed that `cast(? as text)` with `[9007199254740993]` returns the exact digits, that `-9007199254740993` round-trips, and that `1e308` stays a double. No permanent corpus test was added, because a params line past 2^53 would make the corpus fail for downstream harnesses on plain `JSON.parse`.
- Failure output: the same temporary file compared the text `'9007199254740993'` with an expected bigint. It failed as it should. The `Actual:` and `Expected:` lines both print `{"v":"9007199254740993"}`, because `safeJsonStringify` renders a bigint as a string, but the chai text on the next line shows `'9007199254740993'` against `9007199254740993n`. This is cosmetic and left as is. An expected `1e308` likewise prints as its full digit expansion on a mismatch.
- Edge values by reading: `-0` stays distinct from `0` (`03.5-tvf.sqllogic:71` relies on this), a literal too large for a double still becomes an exact bigint, and negative literals are covered by `03-expressions.sqllogic:28`.
- Other consumers: `logic.spec.ts` is the only corpus runner (`packages/tools/planviz/src/visualizer.ts` matched the arrow character only). No references to `normalizeBigInts` remain outside archived tickets, and a grep of corpus comments found no other stale claim about harness rounding.
- Blobs: `Uint8Array` still becomes a plain object keyed by index, as before. The corpus covers this and the JSDoc states it.

**Considered and not ticketed**

- Node version: the reader throws a clear error on a Node without `context.source`, and the repo pins no version (no `engines`, `.nvmrc` or `.github`; confirmed). Only Node 24.2 was run. Failing loudly is the right behaviour, and a pin is outside this ticket.
- Downstream harnesses were not run. The README claim is reasoned: a literal that exactly equals the actual value also rounds to the same double as that value.
- `tickets/fix/bug-text-coercion-in-arithmetic-and-aggregates.md` says the harness cannot yet tell large results apart "until that lands". The wording resolves itself once this ticket lands, so it was left to that ticket's agent.

**Major findings, new tickets, new tripwire comments in code:** none. The one conditional concern is recorded in the README sentence above.

**Tests and lint after the fixes**

- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn test`: exit 0, with 11013 passing and 26 pending in `packages/quereus` (one fewer than the handoff because of the cut row), and no failures in any workspace.
- `QUEREUS_TEST_STORE=true` run of `logic.spec.ts`: exit 0, 370 passing, 7 pending.
