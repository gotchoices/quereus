description: Review cross-check of SQLite date/time + JSON tests against Quereus
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/18-strftime-extended-formats.sqllogic, packages/quereus/test/logic/18-json-string-escapes.sqllogic, packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic, packages/quereus/test/logic/97.1-json-blob-and-special-values.sqllogic
----

## Summary

Cross-checked the **Functions — date/time and JSON** rows of `docs/sqlite-test-crosscheck.md`. Two index rows updated to `reviewed (claude, 2026-05-06)`. No tests were run; no engine code was modified.

### Row dispositions

| Row | Status | Notes |
|---|---|---|
| `date.test`, `date2.test`, `date3.test`, `date4.test` | reviewed | Lenient parsing, weekday/start-of/relative modifiers, strftime basics, epoch round-trip, `subsec`/`unixepoch`, and determinism rejection of `*('now')` already covered. ISO and Sunday-first week-format specifiers (`%V`, `%G`, `%g`, `%U`, plus a `%W` re-pin) added in 18-strftime-extended-formats. `'auto'` / `'julianday'` modifiers (date3) marked n/a — not in Quereus's documented modifier set; Quereus auto-detects numeric JD vs unix-epoch without modifier. date2 runtime-determinism flagging (rejection of `date(col)` at INSERT when col resolves to `'now'`) overlaps statically with 44-determinism-validation; dynamic-row variant is plan-shape and was not separately fixtured. |
| `json1.test`–`json5.test`, `json101.test`–`json104.test` | reviewed | json1–5 n/a (files do not exist upstream — confirmed via 404 at both `test/jsonN.test` and `test/json/jsonN.test`). json101/102 covered. Standard escape sequences and surrogate pairs added in 18-json-string-escapes. BLOB silent-conversion-to-null (Quereus design vs SQLite error), IEEE NaN/Infinity-to-null, and json_object non-string-key rejection added in 97.1-json-blob-and-special-values. json103 window-aggregate form of `json_group_array`/`json_group_object` added in 27.3-window-json-aggregation. json104 (RFC 7396 JSON Merge Patch) n/a — Quereus's `json_patch` implements RFC 6902 JSON Patch operations array (`src/func/builtins/json.ts`); SQLite's merge-patch object syntax is incompatible. `jsonb_*`, JSON5 relaxed syntax, `json_error_position`, `sqlite_offset`, C-API destructor mechanics n/a. |

### New fixtures (4)

- `packages/quereus/test/logic/18-strftime-extended-formats.sqllogic` — `%W`, `%V`, `%G`, `%g`, `%U` strftime specifiers (date4.test).
- `packages/quereus/test/logic/18-json-string-escapes.sqllogic` — standard JSON escape sequences and surrogate-pair handling round-tripping through json_extract / json_quote / json_array, structural chars inside quoted strings, json_valid rejection of malformed escapes (json101.test).
- `packages/quereus/test/logic/27.3-window-json-aggregation.sqllogic` — `json_group_array` / `json_group_object` as window functions with sliding ROWS frame and PARTITION BY (json103-400 / json103-410), plus a GROUP BY regression.
- `packages/quereus/test/logic/97.1-json-blob-and-special-values.sqllogic` — Quereus-specific BLOB → JSON null conversion in `json_array`, `json_object`, `json_group_array`, `json_group_object`; IEEE non-finite → null; non-string `json_object` key rejection (json101 / json103).

### Counts

- Reviewed rows: 2 (covering 9 SQLite test files; 5 of those are 404-confirmed-nonexistent and bracketed under `n/a` in the row notes).
- New fixtures: 4 `.sqllogic` files.
- No engine code modified. No tests / build / lint commands run.

### Validation pointers (for the next pass)

The new fixtures are expected to fail in places — that's intentional per the cross-check process. Specifically:

- `18-strftime-extended-formats.sqllogic` — `docs/datetime.md` only documents `%W` among the alternative-week formats. `%V`, `%G`, `%g`, `%U` are likely emitted literally by Quereus's strftime today (per the doc statement "Unsupported specifiers are outputted literally"). Either implement these specifiers or reclassify the row.
- `18-json-string-escapes.sqllogic` — `json_quote` of an embedded LF asserts `\"a\\nb\"`. Whether Quereus's json_quote emits standard JSON `\n` escape rather than literal LF is the open question.
- `97.1-json-blob-and-special-values.sqllogic` — asserts Quereus's documented `prepareJsonValue` semantics (BLOB → null, NaN/Infinity → null, non-string key → null whole-call). Should pass as-is; if any case throws instead, the test pins the contract.
- `27.3-window-json-aggregation.sqllogic` — `json_group_array` / `json_group_object` are registered via `createAggregateFunction`. If the framework supports window-style invocation for all aggregates this should pass; if not, this fixture is the marker that exposes the gap.

### Process compliance

Per `docs/sqlite-test-crosscheck-process.md`: no `yarn test`, no `yarn build`, no `yarn lint`. Only the index doc and four new fixtures were touched.
