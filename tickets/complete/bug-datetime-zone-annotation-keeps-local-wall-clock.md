description: A date-and-time written with a named time zone was stored as that zone's local clock reading instead of being converted to UTC, so it silently named the wrong instant. All four date and time column types now convert it and reject a zone that cannot be resolved, and the date functions that take modifiers read the same text by the same rules.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-types.ts   # the shared datetime and time parsers; DATE and TIME fallbacks removed or restricted
  - packages/quereus/src/func/builtins/datetime.ts   # parseISOString now calls those parsers (added in review)
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic   # "Named time zones" section
  - docs/types.md   # DATE, TIME and DATETIME validation and canonicalization bullets
  - docs/datetime.md   # accepted formats and "Canonicalization for stored column values"
  - tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md   # one case appended
repro: verified
----

## What changed

`parseDateTimeStringToUtcPlain` is the one parser behind DATE, TIME, DATETIME and TIMESTAMP text input. Its first branch returned the clock reading in the input's own zone. It now converts through the instant, so the UTC reading is what gets stored.

| Input | DATETIME | DATE | TIME |
|---|---|---|---|
| `2020-01-01T00:00:00-05:00[America/New_York]` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T00:00:00[America/New_York]` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T22:00:00-05:00[America/New_York]` | `2020-01-02T03:00:00` | `2020-01-02` | `03:00:00` |
| `2020-01-01[Asia/Tokyo]` | `2019-12-31T15:00:00` | `2019-12-31` | `15:00:00` |
| `2020-11-01T01:30:00-04:00[America/New_York]` | `2020-11-01T05:30:00` | `2020-11-01` | `05:30:00` |
| `2020-11-01T01:30:00-05:00[America/New_York]` | `2020-11-01T06:30:00` | `2020-11-01` | `06:30:00` |

TIMESTAMP stores the matching epoch milliseconds: the second row gives `1577854800000`.

Other behaviour:

- A `[zone]` that cannot be resolved and has no offset is rejected. A zone annotation is told from a calendar annotation by the absence of `=`.
- An offset alongside a zone is enough on its own. `-05:00[Nowhere/Fake]` stores `05:00:00`, and the contradictory `-08:00[America/New_York]` stores `08:00:00`.
- DATE no longer has a `PlainDate.from` fallback. Bare dates parse through the shared parser.
- TIME keeps a time-only fallback, in `parseTimeStringToUtcPlain`, but refuses text carrying a zone annotation or an offset.
- Calendar annotations are dropped, so `2020-01-01T00:00:00[u-ca=hebrew]` stores the bare form.
- A comparison against text that names no instant compares as text, so `where dt = '2020-01-01T00:00:00[Nowhere/Fake]'` returns no rows and raises no error.
- `cast()` of a rejected value returns NULL.

## Behaviour changes to weigh

- **Rows already stored are not corrected.** A row written earlier from a zone-annotated input holds the local reading, and the zone cannot be recovered from the stored value, so no migration can repair it. Canonical stored text parses back unchanged, so rereading an old row does not shift it again. A key column can now hold both an old local reading and a new UTC reading for what was once the same input.
- **Time-only text with an offset is now rejected.** `10:30:00-05:00`, `10:30:00+05` and `T10:30-05:00` were accepted and stored as `10:30:00`. They now raise an error from an insert and from the one-argument `time()`.
- **The earliest and latest dates narrowed slightly.** `date('-271821-04-19')`, `time('-271821-04-19T00:00:00')` and `time('+275760-09-14T10:00:00')` now raise an error, because `PlainDateTime` refuses those values.
- **Modifier forms changed in review.** `date()`, `time()` and `datetime()` with modifiers, plus `strftime()` and `julianday()`, now return NULL for an unresolvable zone and for time-only text with a zone or an offset. They used to return the local reading, ignoring the annotation or offset. An offset alongside a zone now converts in these functions too.

## Review findings

Read the diff of `ticket(implement): bug-datetime-zone-annotation-keeps-local-wall-clock`, then rebuilt the engine and ran about 50 input spellings through the one-argument functions and `cast()`, plus comparisons, defaults and `alter column`.

**Fixed in this pass**

- **Modifier forms still produced the wrong instant.** `parseISOString` in `func/builtins/datetime.ts` had its own fall-through to `PlainDateTime`, which the fix-stage search missed because it stopped at the zoned branch. Verified at the implement commit: `datetime('2020-01-01T00:00:00-05:00[Nowhere/Fake]', '+0 days')` returned `2020-01-01 00:00:00` where the one-argument form gives `05:00:00`. An unresolvable zone returned its local reading, and `date('2020-01-01T00:00:00[u-ca=hebrew]', '+0 days')` returned the malformed `2020-01-01[u-ca=hebrew]`. Its last three branches now call the column types' two parsers, so one set of rules covers both paths. `strftime()` and `julianday()` go through the same function and were re-run. The `epoch_*` functions still return NULL for bracketed text.
- **Regression test for that defect.** One `select` added to the "Named time zones" section. It was not run against the old code, but the old values in the previous finding differ from what it expects.
- **Daylight saving resolution was undocumented.** A no-offset `[zone]` input in the repeated hour takes the earlier instant (`2020-11-01T01:30:00[America/New_York]` stores `05:30:00`), and one in the skipped hour moves forward (`2020-03-08T02:30:00[America/New_York]` stores `07:30:00`). Both were run and are now in `docs/types.md`.
- **Docs.** `docs/datetime.md` now lists the named-zone format and says how the lenient functions treat rejected text.
- **Stale comment.** The TIME type's doc comment still said it used `PlainTime` for validation and parsing.

**Claims from the handoff, now checked**

- **Limited time zone data, the claim the handoff flagged as unverified.** Simulated on Node by making `Intl.DateTimeFormat` refuse every zone but UTC: `[America/New_York]` with no offset is rejected, with `-05:00` it converts, and `[UTC]` and `Z` still work. This is a simulation, not a run on a real limited runtime.
- **`time('+275760-09-14T10:00:00')` errors**, which the handoff had checked only against `Temporal` directly.
- **The `date(dt) = '2020-01-01[Asia/Tokyo]'` case** appended to `bug-date-bucket-rewrite-accepts-non-date-text` reproduces: the filter returns one row and the evaluated comparison is false. Left to that ticket.

**Checked, nothing found**

- Parsing: critical-flag zones (`[!America/New_York]`), offset-style zones (`[+05:00]`), lowercase zone names, a zone plus a calendar annotation, the space separator, `[foo=bar]` (ignored) and `[!foo=bar]` (rejected). The U+2212 minus sign is rejected, so it cannot get past the offset check on TIME.
- `validate` and `parse` cannot disagree on text, because `validatesAs` calls the same parser each type's `parse` uses.
- `in`, `between`, column defaults, temporal arithmetic on stored values, `date('now')`, `time('now')` and `datetime('now')` all behave as documented. Arithmetic reads stored values through `Temporal` directly in `temporal-ops.ts`, which is safe because they are already canonical.
- Links and pinned cases in the docs: the `types-ordering.md#datetime-against-text` anchor exists, and the `dt_filter`, `d_filter` and `t_filter` cases match the rewritten paragraph.

**Tests reviewed and kept**

- The implementer offered `zone_dt` rows 3, 4 and 5 for cutting. They stay: each pins a rule `docs/types.md` states or the `=` branch of the zone check, and each costs one insert.

**Noticed and left alone**

- **Repeated conversion chain.** `toZonedDateTimeISO('UTC').toPlainDateTime()` appears in several arms of `temporal-types.ts`. It is short and clear, so it was not extracted.
- **Tripwire, parked as a `NOTE:` in `parseISOString`:** time-only text now fails the datetime attempts twice. Not measured.

**Major findings and new tickets:** none. The one defect beyond the ticket's scope resolved at a single site and was fixed here.

## Validation

- `yarn test` exits 0 with no failures. The main Mocha run reports 10985 passing and 26 pending. It ran before a final comment-only `NOTE:` edit, after which the targeted test and the lint were rerun.
- `yarn lint` exits 0 across all packages.
- `yarn workspace @quereus/quereus run test --grep "98-temporal"` passes.

Not run: `yarn test:store`. All parsing changed here happens before a value reaches a storage module.
