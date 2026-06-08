---
description: Bloom (hash) join operator implementation — reviewed and fixed
---

## Summary

Implemented a bloom (hash) join operator that replaces nested-loop joins for equi-join predicates, reducing O(n*m) to O(n+m) complexity.

### Files

**Core implementation:**
- `packages/quereus/src/planner/nodes/bloom-join-node.ts` — Physical `BloomJoinNode` plan node
- `packages/quereus/src/runtime/emit/bloom-join.ts` — Emitter with build-phase materialization and probe-phase streaming
- `packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts` — Optimizer rule selecting hash vs nested-loop

**Integration:**
- `packages/quereus/src/runtime/register.ts` — Emitter registration
- `packages/quereus/src/planner/optimizer.ts` — Rule registration in PostOptimization pass

**Tests:**
- `packages/quereus/test/logic/82-bloom-join.sqllogic` — Correctness tests
- `packages/quereus/test/performance-sentinels.spec.ts` — Performance sentinel

### Review Findings and Fixes

1. **LEFT JOIN side-swap bug (fixed)**: The physical selection rule unconditionally swapped probe/build sides based on row count, but for LEFT JOINs the left side must remain the probe side to preserve null-padding semantics. Fixed by only swapping for INNER JOINs.

2. **Collation-unaware key serialization (fixed)**: `serializeKey` used raw string values, ignoring column collations (NOCASE, RTRIM). This caused silent wrong results when joining on columns with non-BINARY collation. Fixed by resolving collation normalizers at emit time and applying them during key serialization.

3. **Tests added**: LEFT JOIN with small-left/large-right (regression test for side-swap), NOCASE collation join, NOCASE LEFT JOIN.

4. **Documentation updated**: `docs/optimizer.md` updated to document collation awareness and side selection constraints. Future directions updated to reflect bloom join is implemented.

### Test Results

All 665 tests pass (including new bloom join edge case tests).
