---
description: Key-driven row-count reduction with FK→PK inference and DISTINCT elimination
prereq: None
---

## Completed

Implemented key-driven cardinality optimization: shared join key-coverage analysis, FK→PK join inference, unique constraint propagation, and DISTINCT elimination.

### Key Components

- **`analyzeJoinKeyCoverage()`** (`src/planner/util/key-utils.ts`): Shared utility used by JoinNode, BloomJoinNode, MergeJoinNode. Checks equi-join pairs against logical/physical keys; when a key is covered, preserves the other side's keys and caps estimatedRows.
- **FK→PK inference**: `checkFkPkAlignment()` in key-utils + `fkPkSelectivity()` in CatalogStatsProvider for tighter selectivity (1/ndv_pk).
- **Unique constraints**: `UniqueConstraintSchema` in table.ts, extracted in schema/manager.ts, surfaced as additional `RelationType.keys` in type-utils.ts.
- **DISTINCT elimination**: `rule-distinct-elimination.ts` removes redundant DISTINCT when source has unique keys (priority 18, structural pass).

### Testing

- 8/8 key-propagation spec tests pass (test/optimizer/keys-propagation.spec.ts)
- sqllogic test 84-key-cardinality passes (FK→PK joins, DISTINCT elimination, unique constraints, multi-table joins)
- TypeScript typecheck clean
- Full suite: 279/280 (sole failure is pre-existing 41-foreign-keys.sqllogic)

### Docs

- `docs/optimizer.md` key-driven section updated with implementation details
