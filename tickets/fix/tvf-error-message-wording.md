----
description: TVF dispatch error wording in `runtime/emit/table-valued-function.ts` and the inner messages in `func/builtins/json-tvf.ts` diverge from what the corpus's `03.5-tvf.sqllogic` asserts (`Error:` prefix, `Function not found:` token). Upstream tests cosmetically pass because of the tautology bug in `executeExpectingError` (see `sqllogic-error-directive-ordering`), but downstream consumers with a structurally correct `.sqllogic` runner surface the divergence.
prereq:
files: packages/quereus/src/func/builtins/json-tvf.ts, packages/quereus/src/runtime/emit/table-valued-function.ts, packages/quereus/test/logic/03.5-tvf.sqllogic, packages/quereus/test/logic.spec.ts
----

# TVF error-message wording divergence

## What the corpus asserts vs. what quereus produces

The failing assertions in `packages/quereus/test/logic/03.5-tvf.sqllogic`:

| Line | Assertion substring                                                       | Actual error message                                                                                      |
|------|---------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| 41   | `Error: Invalid JSON provided to json_each`                               | `Table-valued function json_each failed: json_each() requires a valid JSON value as first argument`       |
| 45   | `Function not found: non_existent_tvf/1`                                  | `Unknown function: non_existent_tvf/1`                                                                    |
| 49   | `Error: json_each requires 1 or 2 arguments (jsonSource, [rootPath])`     | `Table-valued function json_each failed: json_each requires 1 or 2 arguments (jsonSource, [rootPath])`    |
| 53   | `Error: json_each requires 1 or 2 arguments (jsonSource, [rootPath])`     | (same as 49)                                                                                              |
| 57   | `Error: json_tree requires 1 or 2 arguments (jsonSource, [rootPath])`     | `Table-valued function json_tree failed: json_tree requires 1 or 2 arguments (jsonSource, [rootPath])`    |

The substring match is case-insensitive but exact — it expects an `Error:` token immediately preceding the function-specific text. Quereus today either:

- Produces a different prefix (`Table-valued function … failed:` instead of `Error:`),
- Uses a different keyword (`Unknown function:` instead of `Function not found:`), or
- Omits the `Error:` token entirely from the inner message that gets wrapped by the TVF runtime.

## Why this exists

`packages/quereus/test/logic.spec.ts:570-588`'s `executeExpectingError` has a tautology bug — its synthetic "Expected error matching X" message contains X, so `expect(actualError.message).to.include(errorSubstring)` passes unconditionally. The corpus assertions for 03.5-tvf were authored against an older message format and never re-verified once the wrappers in `runtime/emit/table-valued-function.ts` were introduced. Tests pass cosmetically; the substrings are dead.

This is the same family of issue tracked in `sqllogic-error-directive-ordering` — the structural runner bug that masks several engine-side wording / validation gaps.

## Proposed changes

### `packages/quereus/src/runtime/emit/table-valued-function.ts`

- Line 26 (function-not-found path): change
  ```
  throw new QuereusError(`Unknown function: ${functionName}/${numArgs}`, …);
  ```
  to
  ```
  throw new QuereusError(`Function not found: ${functionName}/${numArgs}`, …);
  ```
- Lines 79-86 (variadic arg-count check): prefix the inner error with `Error:` so the wrapped message contains it as a substring:
  ```
  throw new QuereusError(`Error: ${functionName} requires 1 or 2 arguments (jsonSource, [rootPath])`, …);
  ```
- (Optional) Consider replacing the `Table-valued function ${functionName} failed:` wrapper at lines 63 and 105 with a uniform `Error:` prefix so future TVF errors don't need each inner message to embed `Error:` literally. Coordinate with the corpus authors on which token to canonicalize.

### `packages/quereus/src/func/builtins/json-tvf.ts`

- `jsonEachFunc` (lines 36-37): change
  ```
  throw new QuereusError('json_each() requires a valid JSON value as first argument', StatusCode.ERROR);
  ```
  to
  ```
  throw new QuereusError('Error: Invalid JSON provided to json_each', StatusCode.ERROR);
  ```
- `jsonTreeFunc` (lines 138-141): equivalent change — emit `'Error: Invalid JSON provided to json_tree'`.

## Acceptance

`03.5-tvf.sqllogic` passes against quereus.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `TVF_ERROR_WORDING` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry is removed.

## Notes

- The tautological `executeExpectingError` bug is tracked separately in `sqllogic-error-directive-ordering`. Fixing that bug exposes the full breadth of authoring drift, including this one.
- The 8 capital-`Error:` heading comments in the corpus (`03.5-tvf.sqllogic` and `93-ddl-view-edge-cases.sqllogic`) are case-sensitive markers — upstream's case-insensitive parser still treats them as assertions but the tautology bug masks the resulting "error". Worth reviewing while in the file.
