---
description: Access path selection generalized for secondary indexes (seek/range scan)
prereq: none (self-contained)
---

## Summary

Generalized the Titan optimizer's access path selection to use secondary indexes for seek and range scan operations, not just primary keys.

## Review findings

### Code quality
- **Interface (`best-access-plan.ts`)**: Clean, well-typed. Builder pattern is consistent with the rest of the codebase. Validation covers the new fields.
- **Memory module (`module.ts`)**: Index evaluation logic is clear and well-structured. Cost model is simple but reasonable. The `estimatedRows || 1000` change correctly treats 0 as "unknown".
- **Physical node selection (`rule-select-access-path.ts`)**: Dispatcher + two-path split (plan-aware vs legacy) is a sound approach. Fixed mixed indentation (2-space → tabs) and removed unreachable `default` in `opToIndexOp`.
- **Grow-retrieve (`rule-grow-retrieve.ts`)**: Residual predicate fix correctly ANDs unhandled constraint expressions. Clean separation of extraction and residual computation.
- **DESC cursor fixes (`base-cursor.ts`, `transaction-cursor.ts`)**: Symmetrical logic for ASC/DESC with correct startKey and early termination. Logic is duplicated between the two files but each handles its own layer type appropriately.

### `as any` casts
There are ~15 `as any` casts in `rule-select-access-path.ts`, mostly at plan node boundaries (FilterNode constructor, LiteralNode AST expression, constraint arrays). These are a consequence of the loosely-typed plan node interfaces and are consistent with casts elsewhere in the planner.

### Known limitations (documented in task)
- Composite prefix+trailing-range not yet supported at physical scan level
- Sort growth only works when Sort is directly above Retrieve

### Tests
- 665 passing, 7 pending, 0 failing (quereus package)
- 7 new tests in `test/optimizer/secondary-index-access.spec.ts` cover equality seek, range scan, both-bound range, ORDER BY + filter, preference over full scan, composite index, and PK seek regression
- Pre-existing isolation package failures (6) are unrelated (present since isolation review commit)

### Cleanup applied during review
- Fixed mixed indentation in `rule-select-access-path.ts` (38 lines of 2-space → tabs)
- Removed unreachable `default` case in `opToIndexOp` (TypeScript exhaustive checking covers the union type)

### Bug fix applied during review
- **`IndexSeekNode.computePhysical()`** (`table-access-nodes.ts:249`): The single-row uniqueness optimization (`estimatedRows: 1, uniqueKeys: [[]]`) was applied for any non-range seek whose key count matched PK column count. This incorrectly claimed single-row cardinality for secondary index equality seeks (e.g. `WHERE age = 25` on `idx_age` with 1 seek key, PK has 1 column → `1 >= 1` → claimed 1 row). Fixed by gating on `this.indexName === 'primary'`.

### Documentation updates
- `docs/optimizer.md`: Updated access path rule description, parameterization hand-off section, and known limitations to reflect secondary index support and the `indexName`/`seekColumnIndexes` protocol.
