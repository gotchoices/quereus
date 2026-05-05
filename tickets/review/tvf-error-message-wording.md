----
description: TVF error wording aligned with `03.5-tvf.sqllogic` corpus assertions. Three engine sites updated so the substrings the corpus expects (`Error:`, `Function not found:`) appear verbatim in thrown messages.
prereq:
files: packages/quereus/src/runtime/emit/table-valued-function.ts, packages/quereus/src/func/builtins/json-tvf.ts, packages/quereus/test/logic/03.5-tvf.sqllogic
----

# TVF error-message wording — review

## What changed

`packages/quereus/src/runtime/emit/table-valued-function.ts`
- Function-not-found path: `Unknown function: …` → `Function not found: …` (line 26).
- Variadic arg-count check (`json_each` / `json_tree`): inner throw now prefixed with `Error: ` (line 83). After the runtime's `Table-valued function ${functionName} failed:` wrapper composes with this, the corpus's required `Error: <fn> requires 1 or 2 arguments (jsonSource, [rootPath])` substring is still present.

`packages/quereus/src/func/builtins/json-tvf.ts`
- `jsonEachFunc` invalid-JSON throw: `'json_each() requires a valid JSON value as first argument'` → `'Error: Invalid JSON provided to json_each'` (line 36).
- `jsonTreeFunc` invalid-JSON throw: equivalent rewording → `'Error: Invalid JSON provided to json_tree'` (line 140).

The wider `Table-valued function ${functionName} failed:` wrapper (lines 63 / 105 of `table-valued-function.ts`) was left intact — the ticket flagged renaming it as optional and dependent on corpus authors' canonicalization decision.

## Why

Corpus `packages/quereus/test/logic/03.5-tvf.sqllogic` lines 41/45/49/53/57/61 assert specific substrings (`Error: Invalid JSON …`, `Function not found: …`, `Error: <fn> requires 1 or 2 arguments …`) that the engine was not actually emitting. Those assertions appeared to pass under quereus's own runner because of the tautology in `executeExpectingError` (`logic.spec.ts:570-588`) — the synthetic "expected error matching X" message contains X, so substring assertions trivially succeed. Downstream consumers (lamina) with a structurally correct `.sqllogic` runner surface the divergence; their `KNOWN_FAILURES` carries a `TVF_ERROR_WORDING` waiver until this lands.

The `executeExpectingError` tautology itself is **not** addressed here — it's tracked in `sqllogic-error-directive-ordering`.

## Validation

- `yarn test` (memory vtab) — 2453 passing, 2 pending, 0 failing.
- `yarn lint` — 0 errors (only pre-existing `no-explicit-any` warnings in unrelated test files).
- Corpus file `03.5-tvf.sqllogic` unchanged; assertions on lines 41/45/49/53/57/61 now match the actual engine output (substrings present in messages even after the `Table-valued function … failed:` wrapper composes).

## Use cases / behavior to check during review

- `select * from json_each('invalid json');` → message contains `Error: Invalid JSON provided to json_each`.
- `select * from json_tree('invalid json');` → message contains `Error: Invalid JSON provided to json_tree`.
- `select * from non_existent_tvf(1);` → message contains `Function not found: non_existent_tvf/1`.
- `select * from json_each();` and `select * from json_each('[]', '$', 'extra');` → message contains `Error: json_each requires 1 or 2 arguments (jsonSource, [rootPath])`.
- `select * from json_tree();` and `select * from json_tree('{}', '$', 'extra');` → message contains `Error: json_tree requires 1 or 2 arguments (jsonSource, [rootPath])`.

## Notes for reviewer

- The capital-`Error:` heading comments on the corpus file (`-- Error: Invalid JSON`, etc.) are case-sensitive markers that the ticket flagged as worth a glance. They were not modified — quereus's parser is case-insensitive on the `error:` directive token, and changing them is a corpus-style decision that wasn't part of this fix.
- After lamina pulls the new quereus version, its `TVF_ERROR_WORDING` `KNOWN_FAILURES` entry can be removed.
