description: Composite index prefix-equality + trailing-range seeks for MemoryTable
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/base-cursor.ts
  - packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/test/optimizer/composite-prefix-range.spec.ts
  - docs/memory-table.md
----

## What was built

Composite index prefix-equality + trailing-range seeks. For a composite index `idx(a, b)`, queries like `WHERE a = 1 AND b > 5` use the index to seek to the `a=1` prefix and scan only the `b > 5` range within it, rather than falling back to a full scan or first-column-only range.

New plan type `plan=7` (prefix-range) with `prefixLen=N` parameter. Four-layer change: module (detection), planner (emission), scan-plan (parsing), cursors (execution with prefix-aware start keys and early termination).

## Testing

10 tests in `composite-prefix-range.spec.ts`:
- 2-column index with `>`, `>=`/`<=` (BETWEEN), both bounds
- Prefix isolation (no rows outside prefix returned)
- Explain shows IndexSeek
- 3-column index with 2-column prefix
- Composite primary key prefix-range
- Single-column range regression
- Full equality seek regression
- Upper-bound-only prefix-range

All pass. Build and typecheck clean. Pre-existing unrelated failure in `08.1-semi-anti-join.sqllogic`.

## Review notes

- Code follows existing patterns for range/equality handling in cursors
- `planAppliesToKey` and early-termination logic in base-cursor/transaction-cursor have substantial parallelism (pre-existing pattern) — a future DRY pass could extract shared scan filtering logic
- Docs updated in `memory-table.md` (feature list and limitations section)
