description: Eliminated redundant SQL re-parse in Database._evalGenerator
files:
  packages/quereus/src/core/database.ts
  packages/quereus/test/multi-statement.spec.ts
----
## What was done

Removed the redundant `this._parseSql(sql)` call in `_evalGenerator()`. The method was parsing SQL twice — once via `this.prepare(sql)` (which stores the AST batch in `stmt.astBatch`) and again via `this._parseSql(sql)`. The fix replaces the second parse with direct use of `stmt.astBatch`.

## Key files
- `packages/quereus/src/core/database.ts` ~line 1214 — the fix site

## Testing
- 10 dedicated tests in `test/multi-statement.spec.ts` cover:
  - `exec()` multi-statement batches (CREATE+INSERT, multiple UPDATEs, CREATE+INSERT combo)
  - `eval()` multi-statement batches (setup+query, multiple INSERTs+SELECT, single statement)
  - Transaction semantics: commit on break, commit on return(), rollback on throw(), sequential partial consumptions
- Build passes, full test suite passes (one pre-existing unrelated failure in DDL lifecycle test)
