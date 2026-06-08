description: Review of memory table storage layer (B-tree, transactions, cursors, manager)
files:
  packages/quereus/src/vtab/memory/layer/interface.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/vtab/memory/layer/base-cursor.ts
  packages/quereus/src/vtab/memory/layer/connection.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/safe-iterate.ts
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
----
## Findings

### defect: destroy() assignment order causes stale data on new connections
file: packages/quereus/src/vtab/memory/layer/manager.ts:960
After `destroy()`, `_currentCommittedLayer` was set to the OLD base layer (containing data) before the new empty base layer was created. New connections after destroy would see stale data.
Ticket: fixed in review (swapped assignment order)

### smell: planAppliesToKey triplicated across cursor files and manager
file: packages/quereus/src/vtab/memory/layer/base-cursor.ts:40
Nearly identical `planAppliesToKey` logic exists in base-cursor.ts, transaction-cursor.ts, and manager.ts. scanBaseLayer and scanTransactionLayer are also ~95% structurally identical now that inherited BTrees make parent merging unnecessary.
Ticket: tickets/plan/vtab-memory-layer-cursor-dry-refactor.md

### smell: applyBound enum ordering assumption in scan-plan
file: packages/quereus/src/vtab/memory/layer/scan-plan.ts:214
`applyBound` uses `op > lowerBound.op` / `op < upperBound.op` to prefer tighter bounds, but IndexConstraintOp values (GT=4, GE=32, LT=16, LE=8) don't have the assumed ordering. Incorrect bound may be selected when multiple constraints exist. Not a correctness issue since cursors filter, but sub-optimal scan ranges.
Ticket: tickets/fix/scan-plan-applybounds-enum-ordering.md

### smell: dead btreeFuncsCacheForKeyExtraction field in TransactionLayer
file: packages/quereus/src/vtab/memory/layer/transaction.ts:49
Cache Map was declared but never populated or read. `getPkExtractorsAndComparators` creates new PrimaryKeyFunctions on every call instead of caching.
Ticket: fixed in review (removed dead field)

### smell: dead applyChange method on BaseLayer
file: packages/quereus/src/vtab/memory/layer/base.ts:139
`applyChange` and its helpers (`applySecondaryIndexChanges`, `applyPrimaryChange`) were defined but never called. Artifact of pre-inheritree layer collapse mechanism. Manager's `copyTransactionDataToBase` inserts directly into primaryTree instead.
Ticket: fixed in review (removed dead code and unused import)

### note: safe-iterate moveNearest fallback direction
file: packages/quereus/src/vtab/memory/layer/safe-iterate.ts:36
For ascending iteration with a start key beyond all tree entries, the fallback `movePrior` could position on the last element incorrectly. Callers handle this via `planAppliesToKey` filtering, so results are correct but unnecessary entries may be visited.

### note: disconnect deferred cleanup may leak
file: packages/quereus/src/vtab/memory/layer/manager.ts:171
When a connection has a pending uncommitted transaction, `disconnect` defers removal. If the transaction coordinator never commits/rolls back, the connection remains in the map indefinitely.

### note: no dedicated unit tests for safe-iterate or scan-plan
These are tested indirectly through memory-vtable.spec.ts and sqllogic tests but have no isolated unit tests for edge cases (empty trees, boundary start keys, multi-range plans).

## Trivial Fixes Applied
- manager.ts:960-961 — swapped assignment order in `destroy()` so `_currentCommittedLayer` points to the new empty base layer
- transaction.ts:49-54 — removed dead `btreeFuncsCacheForKeyExtraction` field
- base.ts:139-174 — removed dead `applyChange`, `applySecondaryIndexChanges`, `applyPrimaryChange` methods
- base.ts:6 — removed unused `safeJsonStringify` import

## No Issues Found
- interface.ts — clean, well-defined Layer interface
- connection.ts — clean, correct savepoint snapshot/restore logic
- scan-plan.ts (aside from applyBound) — solid decomposition of plan building logic
