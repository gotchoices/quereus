description: ANALYZE emitter uses immutable update pattern instead of mutating frozen TableSchema
files:
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----

## What was built

The `emitAnalyze` emitter was directly mutating `TableSchema` objects via a cast, which threw on frozen schemas (e.g., after ALTER TABLE ADD COLUMN). Replaced with the immutable spread + `schema.addTable()` + `notifyChange()` pattern used by all other DDL emitters.

## Key files

- `packages/quereus/src/runtime/emit/analyze.ts` — immutable spread + addTable + notifyChange pattern (lines 62-73)
- `packages/quereus/test/optimizer/statistics.spec.ts` — two new integration tests (lines 541-587)

## Testing

- "ANALYZE persists statistics on the catalog schema" — verifies `findTable()` returns schema with `statistics` populated after ANALYZE
- "ANALYZE works on frozen schema objects (e.g. after ALTER TABLE)" — ALTER TABLE freezes schema, ANALYZE still persists statistics
- All 13 statistics/ANALYZE tests pass; 329/330 full suite pass (1 pre-existing unrelated failure)
- Build passes with no type errors

## Review notes

- Pattern is consistent with alter-table.ts and add-constraint.ts (verified all emit/*.ts files)
- Resource cleanup: vtab.disconnect() in try/finally
- Error handling: catch logs and continues (best-effort semantics for ANALYZE)
- No direct mutations remain anywhere in emit/ directory
