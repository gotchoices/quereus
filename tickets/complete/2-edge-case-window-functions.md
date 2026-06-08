description: Edge-case sqllogic tests for window function subsystem + ROWS frame bounds fix
prereq: none
files:
  packages/quereus/test/logic/27-window-edge-cases.sqllogic
  packages/quereus/src/runtime/emit/window.ts
----

## Summary

Added 10 edge-case test categories for window functions and fixed a ROWS-mode frame bounds bug.

**Bug fix**: `getFrameBounds()` in `window.ts` previously clamped ROWS-mode start/end bounds during computation, which masked logically empty frames. For example, `ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING` at the first row would clamp both bounds to 0, incorrectly including the current row. Fix: compute raw offsets first, clamp after both bounds are known, so `start > end` correctly detects empty frames.

## Test coverage (27-window-edge-cases.sqllogic)

1. Zero-width frame (`ROWS BETWEEN 0 PRECEDING AND 0 FOLLOWING`)
2. Frame excluding current row (`ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING` / `1 FOLLOWING AND 1 FOLLOWING`) — directly exercises the bug fix
3. Empty partition via WHERE filter
4. Single-row partition — all window functions
5. Mixed ASC/DESC ORDER BY with composite ordering
6. Large LAG/LEAD offsets (100) with and without defaults
7. RANGE vs ROWS peer handling (`RANGE BETWEEN CURRENT ROW AND CURRENT ROW`)
8. Window over zero rows (`WHERE 1=0`)
9. Multiple different window definitions in one query
10. Window + aggregate composition (subquery with window consumed by outer aggregate)

## Validation

- All tests pass, lint clean
- Both consumers of `getFrameBounds` handle the empty-frame sentinel correctly: aggregate loop skips (start > end), value function checks explicitly
