---
description: Extended MemoryTable access planning with multi-value IN index multi-seek; IS NULL/IS NOT NULL handled as residual filters
prereq: none
---

# Extended Constraint Pushdown for MemoryTable — Complete

## What Was Delivered

### Multi-value IN (index multi-seek) — fully wired
- `findEqualityMatches` accepts multi-value IN as equality match for prefix matching, tracking cardinality (product of IN list sizes)
- `evaluateIndexAccess` uses IN cardinality for cost estimation
- New plan type 5 ("multi-seek") in the scan plan system
- `ScanPlan.equalityKeys` for multi-key lookups
- Both `scanBaseLayer` and `scanTransactionLayer` dispatch multi-seek by recursing with individual equality plans
- `selectPhysicalNodeFromPlan` constructs IndexSeekNode with all IN values as seek keys
- Single-column index only (composite IN is future work)

### IS NULL / IS NOT NULL — correct via residual filters
- Tests verify correct behavior for IS NULL and IS NOT NULL on both NOT NULL and nullable columns
- Filtering is handled by residual filter predicates in the plan pipeline, not by index-level optimization

## Review Findings & Fixes

### Removed dead `handleNullConstraints` method
The original implementation included a `handleNullConstraints` pre-pass in `MemoryTableModule.findBestAccessPlan` that was intended to detect IS NULL on NOT NULL columns as impossible (empty result). This code had two compounding issues:
1. **Dead code**: The constraint extractor only handles binary expressions; IS NULL/IS NOT NULL are parsed as unary expressions and never reach `getBestAccessPlan` as `PredicateConstraint` entries
2. **Latent bug**: The empty-result plan (`eqMatch(0, 0)` without `indexName`/`seekColumnIndexes`) would fall through to SeqScan in physical node selection, returning ALL rows with no residual filter — producing wrong results if ever activated

**Fix**: Removed the dead method and added explanatory comments noting what's needed for future implementation (unary constraint extraction + proper empty-result physical node).

### Removed dead IS/IS NOT cases in constraint extractor
The `mapOperatorToConstraint` function had `case 'IS'` / `case 'IS NOT'` branches that could never fire (parser produces unary, not binary, for IS NULL). Replaced with a note about what's needed.

### Updated documentation
- `docs/memory-table.md`: Added IS NULL optimization and single-column IN limitations to current limitations; updated near-term improvements
- `docs/optimizer.md`: Updated predicate analysis limitations to reflect IN list support and IS NULL status

## Files Changed

- `packages/quereus/src/vtab/memory/module.ts` — Updated `findEqualityMatches` for IN; updated `evaluateIndexAccess` cost model; removed dead `handleNullConstraints`
- `packages/quereus/src/vtab/memory/layer/scan-plan.ts` — `equalityKeys` field; plan type 5 handling
- `packages/quereus/src/vtab/memory/layer/base-cursor.ts` — Multi-seek dispatch
- `packages/quereus/src/vtab/memory/layer/transaction-cursor.ts` — Multi-seek dispatch
- `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — Multi-value IN detection and IndexSeekNode construction
- `packages/quereus/src/planner/analysis/constraint-extractor.ts` — Removed dead IS/IS NOT cases
- `docs/memory-table.md` — Updated limitations and roadmap
- `docs/optimizer.md` — Updated predicate analysis limitations

## Testing

12 tests in `packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts`:
- IS NULL on PK / NOT NULL columns (empty result via residual filter)
- IS NOT NULL on PK / NOT NULL columns (all rows)
- IS NULL / IS NOT NULL on nullable columns (correct filtering)
- IN on PK with multiple values (index multi-seek)
- Single-value IN (backward compatibility)
- IN with no matching values (empty result)
- IN combined with other WHERE predicates
- IS NULL + other filters combined
- IS NOT NULL + IN combined

All 12 new tests pass. Full test suite (86 tests) passes. Build clean.

## Future Work
- Unary IS NULL/IS NOT NULL constraint extraction in the constraint extractor
- Proper empty-result physical node type for impossible predicates
- Multi-value IN on composite indexes
- NOT IN, MATCH, LIKE, GLOB constraint pushdown
