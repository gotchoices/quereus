description: Planner-inserted explicit coercion (CastNodes) for cross-category comparisons — reviewed and complete
prereq: none
files: src/planner/building/expression.ts, src/runtime/emit/binary.ts, src/runtime/emit/between.ts, src/runtime/emit/cast.ts, src/util/coercion.ts, src/planner/analysis/constraint-extractor.ts, docs/types.md, docs/runtime.md
----

## Summary

Shifted cross-category comparison coercion from runtime to plan time. The planner now inserts explicit CastNodes when comparing numeric vs textual operands, so the runtime can unconditionally use fast same-category comparison paths.

## Review findings and fixes

**between.ts DRY violation**: After removing runtime coercion, the fast and generic BETWEEN paths had identical bodies. Collapsed to a single path.

**cast.ts dead ternary**: `castFallback` had `typeof value === 'string' ? 0 : 0` — always returns 0. Simplified.

**runtime.md outdated docs**: The "Type Coercion Best Practices" section still described `coerceForComparison` as active. Updated to reflect plan-time CastNode insertion for comparisons, runtime coercion only for arithmetic/aggregates.

## Validation

- Build: clean, no type errors
- Tests: 731 passing, 0 failures (all packages pass)
- Docs: types.md, runtime.md updated to reflect planner-inserted coercion
