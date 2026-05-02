description: DELETE … RETURNING and DELETE-as-subquery observe overlay rows through the isolation layer
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-isolation/src/merge-iterator.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/42-returning.sqllogic
  packages/quereus/test/logic/44-orthogonality.sqllogic
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/isolated-store.spec.ts
----

## Summary

Confirmed and locked in support for `DELETE … RETURNING` and `DELETE`-as-subquery against rows that exist only in the isolation overlay (e.g. inserted earlier in the same transaction). The bug originally reported — "RETURNING with DELETE does not include rows already in overlay" — was already fixed by prior work on overlay FK cascade and deferred-constraint ambiguity, which substantially cleaned up the isolation merge path.

## What was built

No production code changes were required. The isolation layer's existing path is already correct:

- `IsolatedTable.query()` merges overlay + underlying via `mergeStreams` whenever the overlay has changes.
- `mergeStreams` correctly yields overlay-only rows (tombstone=false, no underlying counterpart) through its `underlyingNext.done` branch.
- `IsolatedTable.update({ operation: 'delete' })` returns the pre-deletion data when converting an overlay row to a tombstone, so `runDelete` in `dml-executor.ts` has a non-null `result.row` to feed RETURNING.
- `runDelete` uses the scan-yielded row as `flatRow` for RETURNING (no re-read from the table after deletion).

## Changes landed

- `packages/quereus/test/logic.spec.ts`: removed `42-returning.sqllogic` and `44-orthogonality.sqllogic` from `MEMORY_ONLY_FILES` — they now run cleanly under store mode.
- `packages/quereus-store/test/isolated-store.spec.ts`: added a new `describe('DELETE … RETURNING with overlay-only rows', …)` block with two unit tests:
  - `DELETE … RETURNING sees rows inserted earlier in the same transaction` — same-transaction INSERT then DELETE … RETURNING must yield all 3 inserted rows.
  - `DELETE-as-subquery RETURNING observes overlay rows in composite DML` — `INSERT INTO dst SELECT … FROM (DELETE FROM src RETURNING …)` correctly transfers overlay-only rows from `src` to `dst`.

## Testing notes

- Store unit tests (`yarn workspace @quereus/store test`): 244 passing, including the 2 new overlay-only tests.
- Store-mode sqllogic for `42-returning.sqllogic` and `44-orthogonality.sqllogic` pass individually under `QUEREUS_TEST_STORE=true`.
- Memory-mode logic tests: no regressions.
- Pre-existing flaky `fuzz.spec.ts` "Optimizer Equivalence" property test (random SELECT-only SQL) was observed to fail intermittently; unrelated to this ticket — no DML/isolation code was touched.

## Usage

DELETE … RETURNING and DELETE-as-subquery patterns now reliably observe rows present only in the isolation overlay. This unblocks composite DML idioms such as:

```sql
begin;
insert into src values (1, 'a'), (2, 'b');
insert into dst (id, val) select id, val from (delete from src returning id, val);
commit;
```

…with the expected outcome of `src` empty and `dst` populated.
