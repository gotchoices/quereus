description: Tests for under-covered schema catalog, memory vtab transactions, and core API paths
files:
  packages/quereus/test/logic/101-transaction-edge-cases.sqllogic
  packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic
  packages/quereus/test/logic/103-database-options-edge-cases.sqllogic
  packages/quereus/test/vtab/events.spec.ts
  packages/quereus/test/vtab/best-access-plan.spec.ts
  packages/quereus/test/util/plugin-helper.spec.ts
  packages/quereus/test/util/mutation-statement.spec.ts
  packages/quereus/test/core/database-options.spec.ts
  packages/quereus/test/schema/catalog.spec.ts
  packages/quereus/test/property.spec.ts
----

## What was built

325+ test cases covering schema catalog, vtab events/access-plan, core API (database options, plugin registration), utility functions (mutation statements), and property-based tests.

### Test files

- **101-transaction-edge-cases.sqllogic** — empty txns, double BEGIN/COMMIT/ROLLBACK, commit-after-fail, deeply nested savepoints (3+ levels), same-name savepoints, mixed mutation types across boundaries, large txn rollback, implicit txn with savepoint
- **102-schema-catalog-edge-cases.sqllogic** — DDL round-trip, composite PK, indexes, CHECK constraints, multi-schema declare/apply, cross-schema JOINs, schema_path resolution, table_info edge cases, view lifecycle, DROP IF EXISTS, assertions, window functions
- **103-database-options-edge-cases.sqllogic** — PRAGMA read/set/reset, invalid pragma error handling, multiple pragmas in sequence, table_info on various shapes
- **events.spec.ts** — DefaultVTableEventEmitter: listener registration/invocation/unsubscribe, error resilience, batching lifecycle, removeAllListeners
- **best-access-plan.spec.ts** — AccessPlanBuilder static factories, fluent builder, validateAccessPlan bounds checking
- **plugin-helper.spec.ts** — sync/async plugin registration, config passing, vtable module registration, error wrapping
- **mutation-statement.spec.ts** — INSERT/UPDATE/DELETE generation with single/composite PKs, null handling, context values, no-PK tautology
- **database-options.spec.ts** — option registration, aliases, boolean/number/object conversion, type safety, onChange events, equality detection
- **catalog.spec.ts** — collectSchemaCatalog, generateDeclaredDDL, schema hashing (stability, tag stripping, short hash)
- **property.spec.ts** — collation comparator, numeric affinity, JSON roundtrip, mixed arithmetic, parser robustness, expression evaluation, comparison properties, insert/select roundtrip, temporal roundtrip, conversion idempotency, transaction isolation, ORDER BY stability

## Review findings

- Build passes, all 1697 tests pass (including the new ones)
- Test isolation is solid: `beforeEach`/`afterEach` create fresh instances; SQLLogic tests self-clean with DROP TABLE
- Resource cleanup is correct: database connections closed in `afterEach`, prepared statements finalized in `finally` blocks
- Property tests use reasonable run counts (20-200) for CI speed
- **Fixed during review**: Strengthened three weak assertions in `mutation-statement.spec.ts` that had comments describing expected behavior but no actual verification (composite PK `AND` in UPDATE, `WHERE 1` tautology in DELETE, context value inclusion in INSERT)
