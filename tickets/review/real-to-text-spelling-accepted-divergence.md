description: Review the comment and doc changes that record why Quereus keeps JavaScript's spelling (`1`, `Infinity`) instead of SQLite's (`1.0`, `Inf`) when turning a number into text.
architecture: docs/types.md
files:
  - packages/quereus/src/util/value-text.ts
  - packages/quereus/test/util/value-text.spec.ts
  - docs/types.md
difficulty: easy
---

# Number-to-text spelling recorded as an accepted divergence

Comment and documentation only; no behaviour change.

## What changed

- `src/util/value-text.ts`: the `valueToText` JSDoc paragraph "Number spelling stays `String(v)`" now states the decision (REAL `1.0` and INTEGER `1` are one runtime value and the conversion sees only the value; `Infinity` round-trips through `REAL_TYPE.parse`, `Inf` does not) and no longer points at the old bug slug. Added an accepted-tradeoff `NOTE:` on the `case 'number'` arm with the revisit condition (REAL/INTEGER getting distinct runtime forms).
- `test/util/value-text.spec.ts`: comment on the `1.0` / `Infinity` / `NaN` assertions now says "accepted SQLite divergence (see the NOTE in value-text.ts)". Assertions unchanged.
- `docs/types.md` (~line 957): paragraph rewritten as the decided behaviour with both reasons and the revisit condition. Written as one unwrapped line per project rules, while the surrounding paragraphs are still hard-wrapped.

## Not covered

- NaN admission (SQLite stores NULL for NaN) is a value-domain question left out of scope, as the ticket says; related territory is `bug-sliding-window-sum-poisoned-by-non-finite-real` in backlog.
- `1e+21` vs SQLite's `1.0e+21` is covered implicitly by the `.0` reasoning; the docs paragraph does not mention exponent form separately.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `node test-runner.mjs test/util/value-text.spec.ts` (in `packages/quereus`) ran the full quereus suite: 11181 passing, 23 pending, 0 failing.

No tests added: existing `value-text.spec.ts` already pins the spellings.
