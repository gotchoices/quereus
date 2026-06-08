description: Enforce UNIQUE constraints in memory vtab INSERT/UPDATE paths
files:
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/src/vtab/memory/layer/interface.ts
  packages/quereus/src/vtab/memory/index.ts
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/test/logic/102-unique-constraints.sqllogic
  packages/quereus/test/fuzz.spec.ts
  docs/memory-table.md
----

## Summary

UNIQUE constraints on memory vtab tables are now enforced at mutation time for both primary key and secondary (non-PK) columns. Secondary indexes are auto-created for UNIQUE constraints to enable O(log n) enforcement. NULL values in UNIQUE columns are allowed per SQL standard (multiple NULLs coexist). Conflict resolution (ABORT, IGNORE, REPLACE) is handled consistently across PK and non-PK unique constraints.

The `type-utils.ts` defensive fix ensures nullable UNIQUE columns are not treated as keys for DISTINCT elimination, preventing incorrect query results.

## Review Notes

- Code is clean, well-structured with good separation of concerns (checkUniqueConstraints → checkSingleUniqueConstraint → checkUniqueViaIndex / checkUniqueByScanning)
- NULL handling is correct: the early-return guard at `checkSingleUniqueConstraint` line 735 prevents NULLs from reaching the scanning/index paths
- The rollback logic in `performUpdateWithPrimaryKeyChange` is correct: delete + re-insert-as-new correctly restores index entries
- `uniqueColumnsChanged` optimization correctly iterates all constraints and columns

## Testing

- New sqllogic test file `102-unique-constraints.sqllogic` covering:
  - INSERT duplicate into UNIQUE column → ABORT error
  - INSERT OR IGNORE with UNIQUE violation → silently skipped
  - INSERT OR REPLACE with UNIQUE violation → conflicting row deleted, new row inserted
  - Multiple NULLs in nullable UNIQUE column → allowed
  - UPDATE changing UNIQUE column to conflicting value → error
  - UPDATE not changing UNIQUE columns → no constraint check
  - UPDATE UNIQUE column to same value → no conflict
  - UPDATE UNIQUE column to new value → succeeds
  - Composite UNIQUE constraint enforcement
  - PK-change UPDATE with UNIQUE conflict → old row restored
  - PK-change UPDATE without UNIQUE conflict → succeeds
- Fuzz test `SELECT DISTINCT results are unique` active and passing
- 1724 tests passing, 0 failures
