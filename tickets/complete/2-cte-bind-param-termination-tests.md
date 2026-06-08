---
description: Test coverage for recursive CTE with bind-parameter termination conditions
prereq: none
---

## Completed

Added `-- params: <JSON>` directive to the sqllogic test runner and 8 test cases covering recursive CTEs with bind parameters.

### Changes

| File | Change |
|------|--------|
| `packages/quereus/test/logic.spec.ts` | Added `-- params:` directive parsing (lines 681-688), passes params through `executeExpectingResults` → `executeWithTracing` → `stmt.bindAll()` |
| `packages/quereus/test/logic/13.2-cte-bind-params.sqllogic` | 8 test cases covering seed params, termination params, exclusion params, multi-params, and counting CTEs |

### Test coverage

8 tests exercising distinct code paths through `ParameterReferenceNode` in CTE evaluation:
- Bind param in base case seed (2 tests, different values)
- Bind param in recursive termination condition
- Bind param as exclusion filter in recursive member
- Multiple bind params across base + recursive members (2 tests)
- Counting CTE with parameterized limit
- Counting CTE with parameterized seed + limit

### Validation

- All 8 new tests pass
- Full suite: 668 passing, 7 pending (pre-existing), 0 failures
- No regressions
