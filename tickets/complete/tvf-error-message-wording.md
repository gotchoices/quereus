----
description: TVF error wording aligned with `03.5-tvf.sqllogic` corpus assertions. Three engine sites updated so the substrings the corpus expects (`Error:`, `Function not found:`) appear verbatim in thrown messages.
prereq:
files: packages/quereus/src/runtime/emit/table-valued-function.ts, packages/quereus/src/func/builtins/json-tvf.ts, packages/quereus/test/logic/03.5-tvf.sqllogic
----

# TVF error-message wording — complete

## What was built

Three engine error sites reworded so `03.5-tvf.sqllogic`'s `-- error:` substring assertions match the actual thrown messages (not just the synthetic "expected error matching X" message that quereus's tautological runner produces — see `sqllogic-error-directive-ordering`).

`packages/quereus/src/runtime/emit/table-valued-function.ts`
- `Unknown function: …` → `Function not found: <name>/<argc>` (line 26, emit-time throw, no wrapper).
- Variadic arg-count check for `json_each` / `json_tree`: throw now `Error: <fn> requires 1 or 2 arguments (jsonSource, [rootPath])` (line 83, thrown before the runtime `try` so the wrapper does not compose).

`packages/quereus/src/func/builtins/json-tvf.ts`
- `jsonEachFunc` invalid JSON: `Error: Invalid JSON provided to json_each` (line 36).
- `jsonTreeFunc` invalid JSON: `Error: Invalid JSON provided to json_tree` (line 140).
- Both go through the runtime `Table-valued function ${functionName} failed:` wrapper (`table-valued-function.ts:63/105`); the required substrings remain present after composition.

The `Table-valued function … failed:` wrapper itself was intentionally left alone — restructuring it would change error formatting more broadly and was flagged out-of-scope.

## Key files

- `packages/quereus/src/runtime/emit/table-valued-function.ts` (lines 26, 83) — function-lookup and variadic-arg throws.
- `packages/quereus/src/func/builtins/json-tvf.ts` (lines 36, 140) — invalid-JSON throws.
- `packages/quereus/test/logic/03.5-tvf.sqllogic` (lines 41/45/49/53/57/61) — corpus assertions now match real engine output.

## Testing notes

- `yarn test` (memory vtab) — 2453 passing / 2 pending / 0 failing.
- `yarn lint` — 0 errors (only pre-existing `no-explicit-any` warnings in unrelated test files).
- Behavior covered:
  - `select * from json_each('invalid json');` → message contains `Error: Invalid JSON provided to json_each`.
  - `select * from json_tree('invalid json');` → message contains `Error: Invalid JSON provided to json_tree`.
  - `select * from non_existent_tvf(1);` → message contains `Function not found: non_existent_tvf/1`.
  - `select * from json_each();` and `select * from json_each('[]', '$', 'extra');` → message contains `Error: json_each requires 1 or 2 arguments (jsonSource, [rootPath])`.
  - `select * from json_tree();` and `select * from json_tree('{}', '$', 'extra');` → message contains `Error: json_tree requires 1 or 2 arguments (jsonSource, [rootPath])`.

## Usage / downstream

After lamina pulls a quereus version containing these changes, the `TVF_ERROR_WORDING` `KNOWN_FAILURES` waiver in lamina can be removed.

## Follow-ups (out of scope, tracked separately)

- The `Table-valued function … failed:` wrapper produces a slightly redundant `… failed: Error: …` composition for the invalid-JSON path. Restructuring is deferred until corpus authors decide on canonical formatting.
- The `executeExpectingError` tautology (`logic.spec.ts:570-588`) that masked these wording mismatches inside quereus is tracked in `sqllogic-error-directive-ordering`.
