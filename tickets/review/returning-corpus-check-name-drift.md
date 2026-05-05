----
description: Re-authored `42-returning.sqllogic` to assert the actual error message Quereus emits for column-level unnamed CHECK violations (`_check_positive_value`), replacing the fictional `check_0` substring. Path A from the fix ticket — corpus rewording only; the deeper engine issues (RETURNING under `db.exec` is lazy, and `executeExpectingError` collapses success-path throws into the catch handler) are tracked separately by `sqllogic-error-directive-ordering` and would need to land before the rewording could be validated end-to-end against engine output.
files: packages/quereus/test/logic/42-returning.sqllogic
----

# Returning corpus CHECK name drift

## What changed

`packages/quereus/test/logic/42-returning.sqllogic` previously asserted, on two unnamed column-level CHECK violations, the substring `CHECK constraint failed: check_0`. The engine never produces that string for column-level CHECK in CREATE TABLE — it produces `_check_<column>` (e.g. `_check_positive_value`). Three default-naming code paths exist and they don't collide:

| Authoring                                         | Code site                                  | Default name format     | Example                 |
|---------------------------------------------------|--------------------------------------------|-------------------------|-------------------------|
| Column-level unnamed CHECK in CREATE              | `schema/manager.ts:639`                    | `_check_<column>`       | `_check_positive_value` |
| Table-level unnamed CHECK in CREATE               | `runtime/emit/constraint-check.ts:255-258` | `_check_<index>`        | `_check_0`              |
| `ALTER TABLE … ADD CONSTRAINT CHECK(...)` unnamed | `runtime/emit/add-constraint.ts:38`        | `check_<index>`         | `check_0`               |

The corpus's SQL is column-level, so the only matching substring is `_check_positive_value` (or `positive_value`). Both occurrences (lines 70 and 86) were updated to `_check_positive_value`.

## Why the test was passing before

Two compounding bugs (documented in the original fix ticket and overlapping with `sqllogic-error-directive-ordering`):

1. `INSERT … RETURNING` is pull-based. `db.exec` does not iterate the projected RETURNING rows, so the constraint pipeline never runs and the CHECK never fires. The same INSERT *without* RETURNING throws as expected.
2. `logic.spec.ts:564-588` `executeExpectingError` synthesises a new `Error` whose message *is* the expected substring, throws it inside the same `try` that wrapped `db.exec`, and matches `.to.include(expected)` on the message it just synthesised. Substring match always passes when `db.exec` succeeded silently.

Net effect: `check_0` was never compared against any real engine output. Re-authoring is correct on its own merits regardless of whether the engine bugs land.

## Files touched

- `packages/quereus/test/logic/42-returning.sqllogic:70` — replaced `check_0` with `_check_positive_value`.
- `packages/quereus/test/logic/42-returning.sqllogic:86` — replaced `check_0` with `_check_positive_value`.

## Validation

- Targeted run: `yarn test --grep "42-returning"` — 1 passing.
- Full quereus suite: `yarn test` — 2453 passing, 2 pending. No regressions.
- Did not run `yarn test:store` (corpus-only change; not store-specific).

## Reviewer checks

- Confirm `40-constraints.sqllogic` still asserts on `_check_pos`, `_check_bal`, `_check_status` — those are the authoritative column-level naming and we want them unchanged. (Verified at edit time.)
- Cross-check that `_check_positive_value` is what `schema/manager.ts:639` would actually emit for `CHECK(positive_value > 0)` against column `positive_value`. The format is `_check_<column>` so the assertion is exact, not just a substring.
- The two engine-side bugs (`db.exec` not draining RETURNING, `executeExpectingError` tautology) are intentionally **not** addressed here — Path A only. Both are tracked by `sqllogic-error-directive-ordering`. Once both land, this corpus assertion will become a genuine end-to-end check rather than a passive substring.

## Downstream

Lamina's `lamina-quereus-test` `KNOWN_FAILURES` list contains a `RETURNING_CORPUS_CHECK_NAME_DRIFT` entry. Once lamina consumes the new quereus version, that entry should be removed. Lamina's runner already drains RETURNING and keeps the no-error throw outside the catch (`packages/lamina-quereus-test/src/sqllogic/runner.ts:128-169`), so its own checks would have caught this regardless of the upstream tautology.
