description: Review: DELETE … RETURNING and DELETE-as-subquery observe overlay rows through the isolation layer
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-isolation/src/merge-iterator.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/42-returning.sqllogic
  packages/quereus/test/logic/44-orthogonality.sqllogic
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/isolated-store.spec.ts
----

## What was done

### Investigation

Traced the full execution path for `DELETE … RETURNING` through the isolation layer:

- The scan (source of DELETE) uses `IsolatedTable.query()`, which already merges overlay+underlying via `mergeStreams` when an overlay exists and `hasChanges = true`. No bypass was found.
- The `mergeStreams` implementation correctly yields overlay-only rows (tombstone=false, no corresponding underlying row) from the `underlyingNext.done` branch.
- The DML executor (`runDelete` in `dml-executor.ts`) uses the scan's yielded row as `flatRow` for RETURNING — it does NOT re-read from the table after the deletion.
- `IsolatedTable.update({ operation: 'delete' })` for a row already in the overlay (tombstone=0) converts it to a tombstone and returns the pre-deletion data row, so `result.row` is non-null and `runDelete` yields the flat row for RETURNING.

### Outcome

The isolation layer already handles DELETE … RETURNING correctly for overlay-only rows (same-transaction INSERT+DELETE). The underlying bug described in the ticket comment — "RETURNING with DELETE does not include rows already in overlay" — appears to have been fixed by prior commits (including the overlay-fk-cascade and deferred-constraint-ambiguity work which improved the isolation layer substantially).

The `42-returning.sqllogic` and `44-orthogonality.sqllogic` sqllogic tests were found to already pass in store mode. The MEMORY_ONLY_FILES exclusion comments were stale.

### Changes made

1. **Removed** `42-returning.sqllogic` and `44-orthogonality.sqllogic` from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`.

2. **Added** two unit tests in `packages/quereus-store/test/isolated-store.spec.ts` under a new `describe('DELETE … RETURNING with overlay-only rows', ...)` block:
   - `DELETE … RETURNING sees rows inserted earlier in the same transaction` — inserts 3 rows in a transaction, then DELETE...RETURNING in the same transaction; verifies 3 rows are returned and the table is empty post-DELETE/COMMIT.
   - `DELETE-as-subquery RETURNING observes overlay rows in composite DML` — inserts 3 rows into `src`, then `INSERT INTO dst SELECT id, val FROM (DELETE FROM src RETURNING id, val)`; verifies src is empty and dst has all 3 rows.

## Test results

- Memory mode: **2443 passing**, 2 pending — no regressions
- Store mode (`yarn test:store`): **2431 passing**, 14 pending (12 remaining memory-only exclusions + 2 original pending)
- Store unit tests (`yarn workspace @quereus/store test`): **240 passing** (2 new tests added)

## Review focus

- Confirm the two new unit tests in `isolated-store.spec.ts` adequately cover the same-transaction INSERT+DELETE RETURNING and DELETE-as-subquery patterns.
- Confirm that `42-returning.sqllogic` and `44-orthogonality.sqllogic` now run without issue in store mode (no regressions introduced by removing them from MEMORY_ONLY_FILES).
- Verify no edge cases remain in `mergeStreams` or `IsolatedTable.query()` that could cause overlay rows to be missed for DELETE scans.
