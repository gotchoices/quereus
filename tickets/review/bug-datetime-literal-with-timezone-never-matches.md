---
description: A stored date-and-time could not be found by searching for the text that created it, because writes converted text to one standard spelling and comparisons did not. Comparisons now convert the text the same way, so a timestamp ending in Z or an offset finds its row and sorts correctly.
architecture: docs/types.md
files:
  - packages/quereus/src/types/logical-type.ts              # new optional normalizeComparand hook
  - packages/quereus/src/types/temporal-types.ts            # DATETIME implements the hook
  - packages/quereus/src/types/cast-semantics.ts            # comparandConverter (with memo), castConverter
  - packages/quereus/src/types/comparison-coercion.ts       # the decision: crossTypeCoercion, comparisonGroupCoercions, isComparandSource
  - packages/quereus/src/runtime/emit/cast.ts               # synthetic casts use the comparand conversion
  - packages/quereus/src/runtime/emit/operand-comparator.ts # makeComparisonGroup key (nullif, greatest, least)
  - packages/quereus/src/runtime/emit/subquery.ts           # inMembershipKeys arm 1c (IN over a subquery)
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts # NOT in the original ticket; see below
  - packages/quereus/src/planner/analysis/change-scope.ts   # NOT in the original ticket; see below
  - packages/quereus/src/func/builtins/conversion.ts        # datetime('now') returns the bare spelling
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # new
  - packages/quereus/test/logic/15.1.3-declared-form-write-contract.sqllogic # controls rewritten
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic # section rewritten
  - packages/quereus/test/logic/change-scope.spec.ts        # one new test
  - docs/types-ordering.md                                  # the full rule, new section "DATETIME against text"
  - docs/types.md                                           # corrected statements and pointers only
  - docs/change-scope.md
repro: verified
---

# Comparing a DATETIME against text normalizes the text the way a write does

## Settled decisions (maintainer, 2026-11-03): do not reopen

- DATETIME is a fixed instant. The stored spelling stays bare UTC, so no persisted value or content digest changes.
- Comparing a DATETIME against text normalizes that text the way a write does. Text that does not parse compares as plain text.
- The variadic `datetime(x, modifier…)` family keeps its display spelling and TEXT return type.
- A shape check on a `datetime` column sees the canonical spelling. This gets a documentation note, not a new diagnostic. GitHub issue #28 stays rejected.

## What changed

`LogicalType` has a new optional hook, `normalizeComparand`; only DATETIME defines it. When one side of a comparison has the hook and the other is textual or ANY, `crossTypeCoercion` wraps the other side in a planner-minted (synthetic) cast. ANY counts because an untyped `?` announces it.

A synthetic cast runs `comparandConverter` instead of `lenientCast`. The difference is the point: unparseable text and non-text values pass through unchanged, where CAST gives NULL or reads a number as an epoch. A user-written `cast('junk' as datetime)` is still NULL.

`comparisonGroupCoercions`, `makeComparisonGroup` and `inMembershipKeys` follow the same rule. `datetime('now')` now returns the bare spelling, so storing it no longer stores a `Z`.

## Two fixes the ticket did not list

Both were needed because the change makes a synthetic cast behave differently from a user-written one. Please look at these hardest, since neither was in the reviewed plan.

- **`expression-fingerprint.ts`: synthetic casts now fingerprint as `CAS:`.** The common-subexpression rule merged `x = t` and `cast(x as DATETIME)` in one projection, so the user's cast returned `'junk'` instead of NULL. Removing the fix makes `15.1.4` fail with exactly that. The cost is a missed merge when a query holds both a coercion cast and an identical user-written cast, for every target type rather than only DATETIME.
- **`change-scope.ts`: a watched key is now the converted value.** `scopeValueFromExpr` strips the cast and `bindParameters` substituted the raw bound value, so a `rows` watch on `t = ?` bound to the `Z` spelling keyed on text no stored row has. The query returned the row and the watch never fired, which leaves a live query silently stale. `ParamScopeValue` gained an optional JSON-safe `conversion` field (exported type `ParamScopeConversion`, documented in `docs/change-scope.md`), and binding runs it. This also corrects the same existing bug for a non-DATETIME key: `int_pk = ?` prepared with the text `'5'` keyed on `'5'` and now keys on `5`. User-written casts over a parameter convert the same way, by CAST's rule.

## Validation

Run from the repo root, all passing:

| Command | Result |
|---|---|
| `yarn test` | every workspace passes; `packages/quereus` 10,949 passing, 25 pending |
| `yarn test:store` | 10,942 passing, 32 pending |
| `yarn lint` | clean |
| `yarn docs:check` | **fails on `docs/runtime.md` and `docs/sql-alter.md` only**; neither is touched here, reported in `tickets/.pre-existing-error.md` |
| `QUEREUS_REPR_STRICT=1`, logic files 15.1.3, 15.1.4, 98 only | 3 passing; the full `yarn test:repr-strict` was not run |

`yarn test:fork-strict` and `yarn test:context-strict` were not run.

The test, lint and store runs above predate the final docs-only move described next. No source or test file changed after them.

**Docs placement differs from the ticket.** The ticket asked for this text in `docs/types.md`, but that file went over its 12,000-word cap (12,082 words). `docs/doc-conventions.md` sends new sections to a satellite doc in that case, so the full rule, the shape-check note and the note on rows stored with a `Z` are in `docs/types-ordering.md` § DATETIME against text. `docs/types.md` keeps corrected statements and links, at 11,627 words, up from 11,539. Point the GitHub issue #28 reporter at the satellite section.

`packages/quereus`'s `test` script passes `--bail`, so it shows one failure at a time. Use `yarn workspace @quereus/quereus run test:all` to see them all.

**Plans**, by `query_plan` on the synthetic form with no explicit cast in the SQL:

- `=`, `>=`, BETWEEN and an IN list over a secondary index plan as `INDEX SEEK` or `INDEX RANGE`.
- `t = ?` plans as `INDEX SEEK` over a secondary index and over a primary key.
- Literals fold: the change scope of `t = '2020-01-01T00:00:00Z'` reports the key `2020-01-01T00:00:00`.
- `di.t = s.x` (DATETIME against text) plans as a plain `INNER JOIN ON condition`, no longer a hash join. A `NOTE:` at the `crossTypeCoercion` arm records this.

**Odd bound values**, compared before and after over an unindexed column, a secondary index and a primary key: numbers, booleans, blobs, NULL and unparseable text return the same rows as before. The only differences are the two intended fixes on the `?` route.

**Scan cost**, unindexed `t = ?` over 5,000 rows, median of 5 runs, script not kept:

| | per row |
|---|---|
| No parse (bound number) | 1.4 us in the first run, 3.1 us in the second |
| Per-row parse, before the memo | 23-32 us |
| After the one-entry memo in `comparandConverter` | 2.0-3.9 us |

Run-to-run noise was large, so read these as rough sizes. The per-row figures cover the whole scan, not only the parse.

## Tests added

- `15.1.4-datetime-comparison-normalization.sqllogic` reproduces the ticket's two tables: which queries must now match and which must stay as they were. Seekable predicates run over an unindexed column, a secondary index and a primary key. It also pins bound parameters (`-- params:` works in sqllogic, so no separate spec was needed), USING, storing `datetime('now')`, `cast('junk' as datetime)` staying NULL, the mixed-list gap, and the fingerprint fix. Confirmed failing before the change.
- `change-scope.spec.ts`, "'rows' watch keys on the value the comparison matches, not the bound spelling", covers the watch fix for a DATETIME and an integer key. Confirmed failing with the fix removed.

## Existing tests changed

Each pinned the old mismatch and was checked against the decisions above.

- `15.1.3`: the controls `check (d = '…000Z')` matched nothing before and now admit the row, so they read the spelling with `check (d like '%Z')`. This keeps them able to detect a CHECK seeing the written form, and also pins the shape-check note. The positive `check (d = '…T00:00:00')` is still sharp, because only the literal converts and an unconverted `d` would still fail it. The scope note was rewritten.
- `98-temporal-edge-cases`: the DATETIME pushed-down filter section explicitly pinned "no canonicalization". It now pins the new rule. The DATE/TIME section below it is unchanged, because that question belongs to the blocked ticket `date-time-timestamp-comparisons-against-text`.

## Known gaps and things to probe

- **Collation is dropped on the converted side.** `castedScalarType` keeps a collation only for a textual target, and DATETIME is not textual. So `nocase_text_col < dt_col` now compares under BINARY, a small departure from "unparseable text compares exactly as it does today". I reasoned this only matters for contrived text, such as a date prefix followed by a letter differing in case. Not tested.
- **A synthetic cast can announce DATETIME while holding a number or unparseable text.** It stays inside the comparison, and `nullif`/`greatest`/`least` return the raw argument, so nothing should reach a row. `QUEREUS_REPR_STRICT` passed on the affected files. A new caller reading a synthetic cast's value as a real DATETIME would be wrong.
- **Nullability is over-reported.** `castedScalarType` calls these casts nullable although they cannot produce NULL from a non-null operand. This only costs not-null-dependent optimizations, so it was left alone.
- **Text that differs per row parses per row.** A `NOTE:` at the hook records it. `x = datetime('…')` over a text column measured 87-132 us per row, because `datetime()` is declared non-deterministic and so also runs per row. The memo cannot help either case.
- **Mixed lists stay unconverted.** `text_col in (dt_col, '…Z')` disagrees with the `=` disjunction on the DATETIME member. This is recorded in the `comparisonGroupCoercions` `NOTE` and in `docs/types-ordering.md`.
- **Rows already stored with a `Z`** by the old `datetime('now')` are not migrated and will not match a normalized comparison exactly. `update t set c = datetime(c)` rewrites them; `docs/types-ordering.md` says so. This path has no test.
- **The fingerprint spec has no synthetic-cast case.** Coverage is the `15.1.4` query alone.

## Outside this ticket

- **GitHub issue #28 still needs an answer posted to the reporter, who carries a local patch.** A person posts that. Point them at the shape-check note in `docs/types-ordering.md` § DATETIME against text.
- While measuring, I found an unrelated crash and filed it as `bug-many-inserts-in-one-transaction-overflow-stack` in `backlog/`.
