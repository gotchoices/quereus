description: Review of memory table module (module, table, connection, PK utils, types, logging, index)
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/src/vtab/memory/connection.ts
  packages/quereus/src/vtab/memory/index.ts
  packages/quereus/src/vtab/memory/types.ts
  packages/quereus/src/vtab/memory/utils/primary-key.ts
  packages/quereus/src/vtab/memory/utils/logging.ts
----
## Findings

### smell: getIndexComparator ignores DESC and collation
file: packages/quereus/src/vtab/memory/table.ts:411
`getIndexComparator()` returns a plain `compareSqlValues` comparator that ignores the index's
DESC ordering, column collation, and composite key structure. Used by the isolation layer for
merge scans — could produce incorrect ordering for DESC or collation-specific indexes.
Ticket: tickets/fix/memory-module-getindexcomparator-ignores-desc-collation.md

### smell: findOrRangeMatch uses unsafe `as any` cast
file: packages/quereus/src/vtab/memory/module.ts:383
Accesses `(filter as any).ranges` because the vtab-level `PredicateConstraint` type doesn't
include `ranges` (only the planner's extended type does). Bypasses type safety.
Ticket: tickets/fix/memory-module-or-range-unsafe-cast.md

### note: adjustPlanForOrdering may claim ordering from unrelated index
file: packages/quereus/src/vtab/memory/module.ts:394-417
`adjustPlanForOrdering` checks if *any* available index satisfies ordering, regardless of
whether the plan actually uses that index for access. For secondary index scans where PK
ordering is claimed, the data wouldn't be in PK order. The planner's `rule-select-access-path.ts`
has separate code paths for ordering-only scans which may mitigate this, but the cost adjustment
could still bias plan selection incorrectly.

### note: getStatistics distinct count uses String() coercion
file: packages/quereus/src/vtab/memory/table.ts:179
`values.map(v => String(v))` for distinct counting conflates values of different types
(e.g., number `1` and string `"1"`). Acceptable for cost estimation but imprecise.

## Trivial Fixes Applied
- packages/quereus/src/vtab/memory/module.ts:18 — Updated outdated JSDoc "using digitree" to "using BTree (inheritree)"

## No Issues Found
- packages/quereus/src/vtab/memory/connection.ts — clean
- packages/quereus/src/vtab/memory/index.ts — clean (well-structured with optimized single/composite paths)
- packages/quereus/src/vtab/memory/types.ts — clean
- packages/quereus/src/vtab/memory/utils/primary-key.ts — clean (good error handling, proper optimization paths)
- packages/quereus/src/vtab/memory/utils/logging.ts — clean

## Test Coverage
- 36 tests in test/memory-vtable.spec.ts covering CRUD, composite PK, transactions, savepoints, schema changes, secondary indexes, read-only tables, constraint handling, and TransactionLayer.hasChanges
- Additional sqllogic coverage in test/logic/05-vtab_memory.sqllogic and ~8 other sqllogic files
