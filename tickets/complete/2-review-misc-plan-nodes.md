description: Review of miscellaneous plan nodes (block, sequencing, set ops, cache, sink, remote query, table function, function, view reference, pragma, analyze, transaction, array index)
files:
  packages/quereus/src/planner/nodes/block.ts
  packages/quereus/src/planner/nodes/sequencing-node.ts
  packages/quereus/src/planner/nodes/set-operation-node.ts
  packages/quereus/src/planner/nodes/cache-node.ts
  packages/quereus/src/planner/nodes/sink-node.ts
  packages/quereus/src/planner/nodes/remote-query-node.ts
  packages/quereus/src/planner/nodes/table-function-call.ts
  packages/quereus/src/planner/nodes/function.ts
  packages/quereus/src/planner/nodes/view-reference-node.ts
  packages/quereus/src/planner/nodes/pragma.ts
  packages/quereus/src/planner/nodes/analyze-node.ts
  packages/quereus/src/planner/nodes/transaction-node.ts
  packages/quereus/src/planner/nodes/array-index-node.ts
  packages/quereus/src/runtime/emit/block.ts
  packages/quereus/src/runtime/emit/sequencing.ts
  packages/quereus/src/runtime/emit/set-operation.ts
  packages/quereus/src/runtime/emit/cache.ts
  packages/quereus/src/runtime/emit/sink.ts
  packages/quereus/src/runtime/emit/remote-query.ts
  packages/quereus/src/runtime/emit/table-valued-function.ts
  packages/quereus/src/runtime/emit/pragma.ts
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/src/runtime/emit/transaction.ts
  packages/quereus/src/runtime/emit/array-index.ts
----
## Findings

### defect: SetOperationNode.getType() returns isSet:true for UNION ALL + EXCEPT emitter missing dedup
file: packages/quereus/src/planner/nodes/set-operation-node.ts:43, packages/quereus/src/runtime/emit/set-operation.ts:99
`getType()` unconditionally sets `isSet: true` for all set operations including `unionAll`, which preserves duplicates. The `isSet` flag propagates through downstream nodes. Additionally, the EXCEPT emitter doesn't deduplicate left-side rows, violating SQL standard.
Ticket: tickets/fix/set-operation-isSet-and-except-dedup.md

### defect: ViewReferenceNode uses wrong nodeType and defaults all types to TEXT
file: packages/quereus/src/planner/nodes/view-reference-node.ts:14
ViewReferenceNode sets `nodeType = PlanNodeType.TableReference` making it indistinguishable from tables. All column types default to TEXT_TYPE. The relation type incorrectly defaults to `isReadOnly: false`.
Ticket: tickets/fix/view-reference-node-type-defaults.md

### defect: RemoteQueryNode emitter missing vtab disconnect
file: packages/quereus/src/runtime/emit/remote-query.ts:22
vtabModule.connect() is called without corresponding disconnect in a finally block. Resource leak on early termination or error.
Ticket: tickets/fix/remote-query-vtable-disconnect.md (pre-existing)

### smell: ArrayIndex emitter creates full array copy per access
file: packages/quereus/src/runtime/emit/array-index.ts:11
`Array.from(ctx.context.entries()).reverse()` allocates a full copy of all context entries and reverses it on every column access. Could use reverse iteration instead.

### smell: ScalarPlanNode type check uses duck typing
file: packages/quereus/src/planner/nodes/table-function-call.ts:81, packages/quereus/src/planner/nodes/function.ts:44
Both files check `'expression' in child` to validate ScalarPlanNode instead of using a proper type guard function.

## Trivial Fixes Applied

- sequencing-node.ts:62 — Fixed misleading comment "Sort preserves" → "Sequencing preserves"
- remote-query-node.ts:67 — Renamed `getLogicalProperties()` → `getLogicalAttributes()` to match base class convention (only instance of wrong name in entire codebase)
- block.ts:55-79 — Simplified `withChildren` to remove duplicated constructor call; single identity check + single construction
- sink-node.ts:37-42 — Added identity check (`newChildren[0] === this.source`) to avoid unnecessary re-construction
- pragma.ts (plan node):58-68 — Added `Cached` wrapper for `getAttributes()` to stabilize attribute IDs across calls (was generating new IDs on every call via `nextAttrId()`)
- analyze-node.ts:61-68 — Same `Cached` wrapper fix for `getAttributes()`
- pragma.ts (emit):16-17 — Removed extraneous blank lines

## No Issues Found

- cache-node.ts — clean (proper Cached usage, CacheCapable interface, identity check)
- transaction-node.ts — clean (proper VoidNode extension, all operations covered)
- array-index-node.ts — clean (simple zero-child scalar node)
- emit/block.ts — clean (simple delegation)
- emit/sequencing.ts — clean (straightforward row numbering)
- emit/sink.ts — clean (proper consumption loop)
- emit/cache.ts — clean (shared cache utility, buffering, tracing)
- emit/transaction.ts — clean (all ops handled, proper validation)
- emit/analyze.ts — clean (proper vtab disconnect in finally, graceful error handling)
- emit/table-valued-function.ts — clean (proper slot cleanup in finally)

## Test Coverage

Strong coverage exists for set operations (09-set_operations.sqllogic), transactions (04-transactions.sqllogic, core-api-transactions.spec.ts), cache (07.7-in-subquery-caching.sqllogic, 49-reference-graph.sqllogic), views (08-views.sqllogic), pragmas (multiple sqllogic files), TVFs (03.5-tvf.sqllogic), and remote query (remote-grow-retrieve.spec.ts). ANALYZE has no direct test coverage. The EXCEPT dedup bug is not caught by existing tests (they use primary key tables with no duplicates).
