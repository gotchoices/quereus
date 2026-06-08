description: Make DATETIME/DATE/TIME coercion canonical so equal instants compare equal regardless of input shape (numeric epoch, bare ISO, ISO with Z, offset, or [zone] annotation)
files: packages/quereus/src/types/temporal-types.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic, packages/quereus/test/logic/98-temporal-edge-cases.sqllogic, docs/types.md, docs/datetime.md
----

## Summary

Reworked the column-type `parse`/`validate` cascades for the three textual
temporal types (`DATE`, `TIME`, `DATETIME`) so that equal instants
canonicalize to identical stored strings regardless of input shape. The
implement pass canonicalized DATETIME correctly; review found that DATE/TIME
still leaked wall-clock fields for offset-bearing inputs, and inverted those
cascades to canonicalize-first.

## Canonical form

- **DATETIME**: bare PlainDateTime in UTC, e.g. `"2017-07-14T02:40:00"`.
- **DATE**: `"YYYY-MM-DD"` — the **UTC** date when the input carries an
  offset / `Z` / `[zone]`.
- **TIME**: `"HH:MM:SS[.sss]"` — the **UTC** wall-clock time when the input
  carries an offset / `Z` / `[zone]`.

All comparisons stay on `BINARY_COLLATION`; with all values in the same
canonical zone (UTC) the lex order is the instant order.

## Implementation (post-review)

`packages/quereus/src/types/temporal-types.ts`:

- Private helper `parseDateTimeStringToUtcPlain(v)` tries
  `ZonedDateTime.from` → `Instant.from` (`Z`/offset path, converted to UTC) →
  `PlainDateTime.from` (bare wall-clock).
- `DATETIME_TYPE.parse` / `validate` route both string and numeric branches
  through the helper and emit the bare PlainDateTime form.
- `DATE_TYPE.parse` / `validate` and `TIME_TYPE.parse` / `validate` try the
  helper **first** and fall back to `PlainDate.from` / `PlainTime.from` for
  bare date-only / time-only strings. This is the review fix — see findings
  below.

## Review findings

### What was checked

- The whole implement diff (commit `a9ac64c1`), then re-read the resulting
  `temporal-types.ts` in full.
- Direct verification of `temporal-polyfill` behavior on the key inputs
  (`PlainDate.from`, `PlainTime.from`, `PlainDateTime.from`, `Instant.from`,
  `ZonedDateTime.from`) — covering bare ISO, `Z`, `+00:00`, `+02:00`,
  `+00:00[UTC]`, empty, and malformed strings.
- Cross-referenced every consumer of `DATETIME_TYPE`, `DATE_TYPE`, `TIME_TYPE`
  via `find_references` — only `conversion.ts` (the SQL `date()`/`time()`/
  `datetime()` functions), the registry, and the optimizer/test files import
  them. The functions delegate `.parse!`, so they pick up the canonicalization
  for free.
- Doc reads on `docs/types.md` and `docs/datetime.md` to confirm they match
  the new reality.
- `yarn workspace @quereus/quereus lint` (clean) and
  `yarn workspace @quereus/quereus test` (3642 passing) before and after the
  review-stage edits.

### Major — fixed inline

- **`DATE_TYPE.parse('...+02:00')` and `TIME_TYPE.parse('...+02:00')` were
  *not* canonicalized.** The implement-stage code tried `PlainDate.from` /
  `PlainTime.from` first and only fell through to the helper on throw, but
  `PlainDate.from('2024-01-15T01:30:00+02:00')` happily returns `'2024-01-15'`
  (the wall-clock date in the input zone) instead of throwing, so the UTC
  canonicalization branch was unreachable for any offset-bearing input.
  Concretely: `'2024-01-15T01:30:00+02:00'` should store as `'2024-01-14'`
  (UTC), and `'2024-01-15T10:30:00+02:00'` as `'08:30:00'` — pre-fix both
  came out as the local wall-clock fields. The implement-stage sqllogic
  rows happened to all be at UTC offset zero (`Z`, `+00:00`, `+00:00[UTC]`),
  so this case was never exercised. Inverted both cascades to try the helper
  first; added a regression section to `98-temporal-edge-cases.sqllogic`
  exercising `+02:00` and `-05:00` against both DATE and TIME, including the
  midnight-crossing dates.

### Minor — fixed inline

- `docs/types.md` DATE and TIME entries had not been updated; only DATETIME
  mentioned the new accepted shapes / canonicalization. Added matching
  "Validation" and "Canonicalization" notes for both, including the explicit
  `+02:00` → `08:30:00` example so the offset-shift semantics are documented,
  not just emergent from the code.

### Minor — left as-is, deliberately

- **`TIME_TYPE.parse('2024-01-15')` returns `'00:00:00'`** (because
  `PlainDateTime.from` accepts date-only and defaults time to midnight, then
  `.toPlainTime()` extracts midnight). The implementer flagged this; left
  unchanged because (a) the resulting value is internally consistent, (b)
  blocking it would require either a custom string-shape guard *or* a wider
  rejection of date-only input in the helper, both of which add complexity
  for a thin correctness win, and (c) `DATETIME_TYPE.parse('2024-01-15')`
  already accepts the same string as `'2024-01-15T00:00:00'`, so a separate
  prohibition in TIME would be asymmetric. If stricter input typing is
  desired, it should be a project-wide decision and a separate ticket.
- **Lenient SQL function outputs unchanged.** `datetime('now')` still calls
  `new Date().toISOString()` and returns a `Z`-suffixed string verbatim —
  the implementer's call. If that result is then inserted into a DATETIME
  column it does canonicalize, so cross-column equality is safe; only direct
  string equality against a function-call result would differ.
- **`Z`-suffix branch via `Instant.from` discards sub-millisecond precision.**
  The polyfill's `Instant` truncates beyond microseconds in some inputs;
  none of our paths exercise sub-microsecond precision today and no test
  covers it. Out of scope.
- **No TS-level unit tests in `test/type-system.spec.ts` for the new
  cross-representation behavior.** Coverage is sqllogic-only (which is
  arguably the better integration-level surface). The existing
  `type-system.spec.ts` DATE/TIME suites are already thin; adding a single
  cross-rep test for each would be modest churn — left to a follow-up if a
  reviewer wants it.

### Pre-existing behavior intentionally not changed

- `DATETIME_TYPE.bucketBounds` still produces ISO datetime strings of the
  bare form, matching the canonical storage shape; no change needed.
- `DATE_TYPE.compare` and `TIME_TYPE.compare` stay on `BINARY_COLLATION` —
  with the storage shape now uniform this is correct without further work.

## Validation

- `yarn workspace @quereus/quereus lint` → clean (exit 0), pre- and
  post-review edits.
- `yarn workspace @quereus/quereus test` → 3642 passing, 9 pending, 0
  failing, both before and after the review-stage edits.
- Did not run `yarn test:store` per AGENTS.md guidance (default `yarn test`
  is the agent default; `test:store` is reserved for store-specific issues
  or releases).

## Follow-ups (none filed)

No findings rose to "file a separate ticket" — the major was fixable in this
pass, and the deliberate-leave items above are scope decisions, not bugs.
