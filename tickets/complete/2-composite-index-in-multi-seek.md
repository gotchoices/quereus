description: Composite index IN multi-seek for MemoryTable
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/test/optimizer/secondary-index-access.spec.ts
  - docs/memory-table.md
----

## What was built

For composite indexes like `idx(a, b)`, queries with `IN` on one or more columns now generate
individual index seeks for each value combination (cross-product) rather than falling back to a
less efficient access path.

### Key changes

- **Planner** (`rule-select-access-path.ts`): Added composite IN multi-seek path in
  `selectPhysicalNodeFromPlan`. Uses `cartesianProduct` helper to generate all value combinations.
  Encodes `seekWidth` in `idxStr` so the scan-plan builder can reconstruct composite keys.
- **Scan-plan builder** (`scan-plan.ts`): Plan=5 handler now parses `seekWidth` from idxStr and
  groups flat args into composite `equalityKeys` arrays when `seekWidth > 1`.
- **No cursor changes** needed — existing multi-seek loop already handles composite keys.
- **Docs** (`memory-table.md`): Updated limitation note to reflect the new capability.

### Review notes

- Fixed variable shadowing: renamed inner `constraints` to `seekConstraints` in the composite
  IN block to avoid shadowing the function parameter.
- Backward compatible: default `seekWidth=1` preserves existing single-column IN behavior.

## Testing

12 tests passing in `secondary-index-access.spec.ts`, including 5 specific to this feature:
- `idx(a, b)` with `WHERE a IN (...) AND b = ?` — 2 seeks, 2 correct rows
- `idx(a, b)` with `WHERE a = ? AND b IN (...)` — 2 seeks, 2 correct rows
- `idx(a, b)` with `WHERE a IN (...) AND b IN (...)` — 4 seeks (cross-product), 4 correct rows
- Explain shows IndexSeek for composite IN queries
- Single-column IN regression test still passes
