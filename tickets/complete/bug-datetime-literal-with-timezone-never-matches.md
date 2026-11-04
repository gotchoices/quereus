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

## Review findings

Reviewed from the diff of `ticket(implement): bug-datetime-literal-with-timezone-never-matches`, then by running probe scripts against the engine. The probes are not kept; the outcomes are recorded here.

**Fixed in this pass**

- **Bug: a serialized change scope lost the parameter conversion.** `serializeChangeScope` and `deserializeChangeScope` dropped the new `conversion` field, so a scope sent over JSON and then bound keyed on the `Z` spelling and its watch never fired. This is the stale-watch bug the implementer fixed, still present on the JSON path, and it broke the "structurally identical" promise in `docs/change-scope.md`. The wire form now carries it as `c`. Reproduced before the fix and added a test in `change-scope-analyzer.spec.ts` ("keeps the conversion a bound parameter needs").
- **Cleanup in `scopeValueFromExpr`:** replaced the mix of a `nodeType` check, an `as unknown as` cast and `instanceof` with one `instanceof CastNode` check.
- **Stale reference:** the `15.1.4` header pointed at `docs/types.md`; the rule lives in `docs/types-ordering.md`.
- **Source hygiene:** rewrapped an overlong line in the `comparisonGroupCoercions` `NOTE`.
- **Docs:** `docs/usage-types.md` is the user-facing DATETIME page and said nothing about comparisons. It now has one sentence and a link.

**Filed**

- `bug-datetime-zone-annotation-keeps-local-wall-clock` in `tickets/fix/`. A value with a named zone, such as `…-05:00[America/New_York]`, stores the local clock reading rather than UTC, contrary to `docs/types.md`. Reproduced. It predates this ticket, and fixing it changes what new writes store, so it was not fixed here.

**Tripwire added**

- A bound `conversion` naming a type the process has not registered falls back to BLOB and watches a wrong key. `NOTE:` at the substitution in `bindParameters`.

**Checked, no defect**

- **The two fixes the implementer flagged.** The fingerprint split is kept for every target type. `rule-scalar-cse` is its only consumer, so the cost is only a missed merge, and narrowing it to DATETIME would add a condition for a rare query. The watch fix behaves as documented for DATETIME and for an integer key, apart from the serialization defect above.
- **Seeks on the converted side.** `text_col = cast('…Z' as datetime)`, and the range, IN and parameter forms, over a text index and a text primary key return every spelling of the instant. `unwrapCast` strips only no-op casts, so the column under a converting cast is never used as a seek key.
- **False equalities.** `distinct` and `group by` over `x = t` keep two text spellings of one instant apart, and pinning either side still filters correctly.
- **Non-text comparands.** Numbers, bigints, booleans, blobs, NULL and unparseable text through `greatest`, `least`, `nullif`, simple CASE, IN and BETWEEN, bound and from an ANY column, order by storage class without throwing.
- **Subquery forms.** Empty and all-NULL subqueries, correlated IN, NOT IN with and without NULL members, EXISTS, scalar subqueries, a UNION ALL mixing text and DATETIME, and `in (null, t)`.
- **Other paths.** UPDATE and DELETE by a `Z` spelling, and `t + timespan(...) = '…Z'`. A partial index predicate spelled with a `Z`: the results are correct, though the probed plans chose the primary key, so the partial index itself was not exercised.
- **Plans.** Index seek or range for `=`, `>=`, BETWEEN and IN, and for `t = ?` on a secondary index and a primary key. `di.t = s.x` is a plain join with a condition, as the ticket says.
- **Tests.** Nothing cut. The three-table repetition in `15.1.4` is justified because each table reaches the comparison by a different route.

**Considered and left alone**

- `inMembershipKeys` arm 1c re-derives what `comparisonGroupCoercions` decides, as arms 1 and 1b already did. Unifying them is a refactor of existing code with no defect behind it.
- The known gaps the handoff lists (collation dropped on the converted side, over-reported nullability, mixed lists, per-row parsing, rows already stored with a `Z`). Each is documented or carries a `NOTE:`. A column holding a `Z` could not be created for a test, so `update t set c = datetime(c)` is confirmed by reading the code only.
- The memo and per-row timings in the handoff were not re-measured.

**Validation after the fixes**

| Command | Result |
|---|---|
| `yarn lint` | clean |
| `yarn docs:check` | passes; the `docs/runtime.md` and `docs/sql-alter.md` failures were resolved by the triage commit |
| `yarn test` | passes; `packages/quereus` 10,950 passing, 25 pending |
| `yarn test:store` | 10,943 passing, 32 pending |
| `yarn test:repr-strict` | 10,959 passing, 16 pending |
| `yarn test:fork-strict` | 10,930 passing, 45 pending |
| `yarn test:context-strict` | 10,953 passing, 22 pending, on a solo re-run |
| `yarn build`, `yarn bench:gate` | build done; gate passed |

The first `yarn test:context-strict` run stopped on a 10-second timeout in `test/property.spec.ts` (View Round-Trip Laws, decomposition fan-out) while the fork-strict and store suites ran at the same time. It passed when run alone. That test does not involve DATETIME, so load is the likely cause, though this was not proven further.

**Still open outside the code:** a person needs to answer GitHub issue #28, pointing the reporter at the shape-check note in `docs/types-ordering.md` § DATETIME against text.
