description: Review of utility modules (async, hashing, serialization, coercion, patterns, etc.)
files:
  packages/quereus/src/util/affinity.ts
  packages/quereus/src/util/async-iterator.ts
  packages/quereus/src/util/cached.ts
  packages/quereus/src/util/coercion.ts
  packages/quereus/src/util/comparison.ts
  packages/quereus/src/util/environment.ts
  packages/quereus/src/util/event-support.ts
  packages/quereus/src/util/hash.ts
  packages/quereus/src/util/key-serializer.ts
  packages/quereus/src/util/latches.ts
  packages/quereus/src/util/mutation-statement.ts
  packages/quereus/src/util/patterns.ts
  packages/quereus/src/util/plan-formatter.ts
  packages/quereus/src/util/plugin-helper.ts
  packages/quereus/src/util/row-descriptor.ts
  packages/quereus/src/util/serialization.ts
  packages/quereus/src/util/sql-literal.ts
  packages/quereus/src/util/working-table-iterable.ts
----
## Findings

### defect: simpleGlob `?` wildcard broken
file: packages/quereus/src/util/patterns.ts:43
The regex escape step did not include `?` in the character class, so `?` passed through
unescaped. The subsequent `.replace(/\\\?/g, '.')` never matched, leaving `?` as a regex
quantifier instead of being converted to `.` (match any single character). GLOB patterns
using `?` would produce incorrect matches (e.g., `a?b` would match "ab" and "b" instead
of "aXb").
Ticket: fixed in review — added `?` to the escape character class

### defect: fnv1aHash loses multiplication carry
file: packages/quereus/src/util/hash.ts:31-32
The 64-bit FNV-1a multiplication truncates the low word via `>>> 0` before extracting
the carry for the high word. The carry is always zero, degrading hash quality in the
upper 32 bits. The hash remains deterministic and functional but does not produce
standard FNV-1a values.
Ticket: tickets/fix/hash-fnv1a-carry-loss.md

### smell: async-iterator next() loses original error when cleanup also throws
file: packages/quereus/src/util/async-iterator.ts:56-59
The `next()` error path called `runCleanup(false)` without catching cleanup errors,
meaning a cleanup failure would replace the original iterator error. The `return()` and
`throw()` methods handled this correctly by separating cleanup errors. Inconsistency
could mask root-cause errors in production.
Ticket: fixed in review — wrapped cleanup in try/catch, preferring the original error

### smell: redundant condition in tryParseInt
file: packages/quereus/src/util/affinity.ts:27
`if (remainingStr && remainingStr !== '')` — the second check is redundant since a
non-empty string is truthy.
Ticket: fixed in review — simplified to `if (remainingStr)`

### note: RTRIM_COLLATION returns non-normalized comparison values
file: packages/quereus/src/util/comparison.ts:52
Returns `lenA - lenB` (arbitrary integer) rather than -1/0/1 like other collation
functions. Functionally correct for sort/comparison use, but inconsistent style.

### note: Cached<T> cannot cache `undefined` values
file: packages/quereus/src/util/cached.ts:8
Uses `undefined` as the sentinel for "not yet computed", so a compute function returning
`undefined` triggers recomputation on every access. Documented by the type signature
(`T | undefined`), acceptable trade-off for the class's simplicity.

### note: affinity functions appear to be dead code
file: packages/quereus/src/util/affinity.ts
`applyRealAffinity`, `applyIntegerAffinity`, `applyNumericAffinity`, `applyTextAffinity`,
`applyBlobAffinity` are not imported anywhere. Previously noted in review
`review-core-utilities`. Left in place pending future use or cleanup.

## Trivial Fixes Applied
- patterns.ts:43 — added `?` to escape regex character class so GLOB `?` wildcard works
- affinity.ts:27 — removed redundant `&& remainingStr !== ''` condition
- async-iterator.ts:56-59 — wrapped cleanup call in try/catch to preserve original error

## No Issues Found
- cached.ts — clean (aside from undefined note above)
- coercion.ts — clean
- environment.ts — clean
- event-support.ts — clean
- key-serializer.ts — clean
- latches.ts — clean
- mutation-statement.ts — clean
- plan-formatter.ts — clean
- plugin-helper.ts — clean
- row-descriptor.ts — clean
- serialization.ts — clean
- sql-literal.ts — clean
- working-table-iterable.ts — clean

## Validation
- Build passes
- 472 tests pass (1 pre-existing failure in optimizer/keys-propagation.spec.ts, unrelated)
