---
description: Global deferred assertions — plan caching, classification, error messages, tests
prereq: Schema system, transaction infrastructure, optimizer, constraint-extractor
---

## Summary

Enhanced the global deferred assertion infrastructure with plan caching, improved classification, better error messages, and comprehensive test coverage.

### Components

| Component | Path |
|-----------|------|
| Assertion evaluator | `packages/quereus/src/core/database-assertions.ts` |
| Database (cache API) | `packages/quereus/src/core/database.ts` |
| Constraint extractor | `packages/quereus/src/planner/analysis/constraint-extractor.ts` |
| Drop assertion emitter | `packages/quereus/src/runtime/emit/drop-assertion.ts` |
| Test suite | `packages/quereus/test/logic/95-assertions.sqllogic` |

### Key Features

- **Plan caching**: `CachedAssertionPlan` stores analyzed plan, classifications, relation mappings, and pre-compiled row-specific artifacts. Invalidated on schema changes via `SchemaChangeNotifier` generation counter.
- **Classification**: `analyzeRowSpecific()` classifies table references as `'row'` or `'global'`. Post-processing demotes to `'global'` beneath identity-breaking nodes (aggregates without PK grouping, set operations, windows).
- **Error messages**: Violation errors include up to 5 sample violating row tuples.
- **DROP ASSERTION**: Invalidates cached plan via `Database.invalidateAssertionCache()`.
- **Diagnostics**: `explain_assertion()` TVF exposes classification and prepared PK params.

### Review Fixes

- Removed dead `found` variable in `findTargetRelationKey()` (`constraint-extractor.ts`)
- Added `dispose()` to `AssertionEvaluator` — unsubscribes schema change listener and clears plan cache
- Wired `assertionEvaluator.dispose()` into `Database.close()` to prevent listener leak

### Test Coverage

13 test sections in `95-assertions.sqllogic` covering: DDL round-trip, violation at COMMIT, single-table CHECK-like, multi-table FK-like, aggregate-based global, rollback clears violations, savepoint interaction, DROP IF EXISTS, duplicate CREATE, autocommit mode, unrelated table optimization, explain diagnostics, multiple assertions.

665 tests passing, 0 failures.
