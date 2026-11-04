description: A date-and-time written with a named time zone was stored as that zone's local clock reading instead of being converted to UTC, so it silently named the wrong instant. All four date and time column types now convert it, and a zone that cannot be resolved is rejected.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-types.ts   # parser helpers, DATE and TIME fallbacks removed or restricted
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic   # new "Named time zones" section at the end
  - docs/types.md   # DATE, TIME and DATETIME validation and canonicalization bullets
  - docs/datetime.md   # "Canonicalization for stored column values" section
  - tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md   # one case appended, see below
repro: verified
----

## What changed

`parseDateTimeStringToUtcPlain` is the one parser behind DATE, TIME, DATETIME and TIMESTAMP text input. Its first branch returned the clock reading in the input's own zone. It now converts through the instant, so the UTC reading is what gets stored.

| Input | DATETIME | DATE | TIME |
|---|---|---|---|
| `2020-01-01T00:00:00-05:00[America/New_York]` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T00:00:00[America/New_York]` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T22:00:00-05:00[America/New_York]` | `2020-01-02T03:00:00` | `2020-01-02` | `03:00:00` |
| `2020-01-01T05:00:00+09:00[Asia/Tokyo]` | `2019-12-31T20:00:00` | `2019-12-31` | `20:00:00` |
| `2020-01-01[Asia/Tokyo]` | `2019-12-31T15:00:00` | `2019-12-31` | `15:00:00` |
| `2020-01-01T05:00:00Z[America/New_York]` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-11-01T01:30:00-04:00[America/New_York]` | `2020-11-01T05:30:00` | `2020-11-01` | `05:30:00` |
| `2020-11-01T01:30:00-05:00[America/New_York]` | `2020-11-01T06:30:00` | `2020-11-01` | `06:30:00` |

All of these were produced by the built engine through the one-argument `datetime()`, `date()` and `time()` functions. TIMESTAMP was checked by inserting the first row: it stores `1577854800000`.

Other behaviour:

- A `[zone]` that cannot be resolved and has no offset is rejected. `ZONE_ANNOTATION` tells a zone annotation from a calendar annotation by the absence of `=`.
- An offset alongside a zone is enough on its own. `-05:00[Nowhere/Fake]` stores `05:00:00` and the contradictory `-08:00[America/New_York]` stores `08:00:00`. The helper's doc comment says this is deliberate, and `docs/types.md` states it.
- DATE no longer has a `PlainDate.from` fallback. Bare dates parse through the helper.
- TIME keeps a time-only fallback, now in `parseTimeStringToUtcPlain`, but refuses text carrying a zone annotation or an offset.
- The bare branch drops calendar annotations, so `2020-01-01T00:00:00[u-ca=hebrew]` stores the bare form.
- `normalizeComparand` catches the new rejection and compares the text as text: `where dt = '2020-01-01T00:00:00[Nowhere/Fake]'` returns no rows and raises no error.

`cast()` of a rejected value returns NULL, as it does for other junk text: `cast('10:30:00-05:00' as time)` and `cast('2020-01-01T00:00:00[Nowhere/Fake]' as datetime)` were both checked.

## Behaviour changes to weigh

- **Rows already stored are not corrected.** A row written earlier from a zone-annotated input holds the local reading, and the zone cannot be recovered from the stored value, so no migration can repair it. Canonical stored text parses back unchanged, so rereading an old row does not shift it again. A key column can now hold both an old local reading and a new UTC reading for what was once the same input.
- **Time-only text with an offset is now rejected.** `10:30:00-05:00`, `10:30:00+05` and `T10:30-05:00` were accepted and stored as `10:30:00`. They now raise an error from an insert and from `time()`. No test or doc example used these spellings.

Two narrower changes the ticket did not list, found by calling `Temporal` directly and then confirmed on the built engine:

- `date('-271821-04-19')` now errors. It is the earliest date `PlainDate` allows, and `PlainDateTime` refuses its midnight. Every other spelling tried gave the same accept or reject result under both parsers.
- `time('-271821-04-19T00:00:00')` now errors. It parsed before only because `PlainTime.from` does not check the date's range. The same reasoning covers `+275760-09-14T10:00:00`, which was checked against `Temporal` but not run through the engine.

## Beyond the ticket

- `validatesAs` replaces three copies of the same `validate` body across DATE, TIME and DATETIME, since two of the three were being rewritten anyway.
- `docs/datetime.md` said only column-type `parse` canonicalizes. That was already wrong for the one-argument `date()`, `time()` and `datetime()`, so it now says those convert through `parse` and the other forms stay lenient. `datetime(x, '+0 days')` returning the space-separated form was the check that the modifier form takes a different route.
- Doc comments on DATE and DATETIME that described the old behaviour were corrected.

## Tests

One new section in `98-temporal-edge-cases.sqllogic`, "Named time zones". It failed before the fix at the first `select` (`row 0 mismatch`, `dt` was `2020-01-01T22:00:00`).

- `zone_all` select: all four column types convert, across three inputs that cover offset plus zone, zone with no offset, and date only.
- `zone_all` `where dt = '2020-01-01T05:00:00Z'`: a literal for the same instant finds the row.
- `zone_dt` rows 1 and 2: the repeated hour stores two distinct values.
- `zone_dt` rows 3, 4 and 5: unknown zone with an offset, contradictory offset, and calendar annotation. These go beyond the ticket's list, pinning the deliberate offset rule and the `=` test in the regular expression. Cut them if they do not pay.
- `zone_reject`: unknown zone errors for DATETIME, DATE and TIME; time-only text with a zone and with an offset errors.

## Validation

- `yarn workspace @quereus/quereus run test --grep "98-temporal"` passes.
- `yarn test` exits 0 with no failures. The main Mocha run reports 10985 passing and 26 pending. It ran before two comment-only edits; the targeted test and the lint were rerun after them.
- `yarn lint` exits 0 across all packages, and the `packages/quereus` lint was rerun after those edits.

Not run:

- `yarn test:store`, because the ticket says zone handling does not differ by storage module.
- Any runtime with limited time zone data. `docs/types.md` says a valid zone name the runtime has no data for is rejected. That comes from reading the code path, not from a run on such a runtime, so it is the claim to doubt first.

## Review findings index

- `where date(dt) = '2020-01-01[Asia/Tokyo]'` returns a row, while `select date(dt) = '2020-01-01[Asia/Tokyo]'` is false. The date bucket rewrite drops the annotation. This was not caused by this ticket and its code was left alone. The case is appended to `bug-date-bucket-rewrite-accepts-non-date-text`, which already owned that site.
