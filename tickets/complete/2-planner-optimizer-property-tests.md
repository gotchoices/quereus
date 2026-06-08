description: Property-based tests targeting planner and optimizer correctness invariants
prereq: fast-check (already in devDependencies)
files:
  - packages/quereus/test/property-planner.spec.ts (20 tests across 6 property groups)
  - packages/quereus/src/planner/optimizer-tuning.ts (disabledRules field)
  - packages/quereus/src/planner/framework/pass.ts (skip disabled rules in applyPassRules)
  - packages/quereus/src/planner/framework/registry.ts (skip disabled rules in applyRules)
  - docs/optimizer.md (added disabledRules mention)
----

## What was built

### Infrastructure: selective rule disabling

`disabledRules?: ReadonlySet<string>` on `OptimizerTuning`. Guard checks in both rule application paths:
- `PassManager.applyPassRules()` in `pass.ts` (line ~380)
- `applyRules()` in `registry.ts` (line ~198)

### Test file: `test/property-planner.spec.ts` (20 tests)

- **Semantic equivalence under optimizer rules** (8 tests): One per rewrite rule, verifying result sets match with rule enabled vs disabled.
- **Optimizer determinism** (1 test): Same query → identical `query_plan()` on repeated prepare.
- **Join commutativity** (1 test): `t1 JOIN t2` = `t2 JOIN t1` with aliased columns.
- **Monotonicity of WHERE** (1 test): `count(*)` >= `count(*) WHERE col IS NOT NULL`.
- **NULL algebra** (5 tests): Core NULL semantics (equality, IN, COALESCE, IS NULL/IS NOT NULL, count).
- **Aggregate invariants** (4 tests): count/min/max/sum/avg relationships.

## Review findings

- **disabledRules guard coverage**: Both `rule.fn()` call sites (pass.ts, registry.ts) have the guard. No other paths invoke rules.
- **Rule IDs**: All 8 rule IDs in tests match actual registered rule IDs.
- **API usage**: `db.optimizer.tuning` and `db.optimizer.updateTuning()` are valid public API.
- **Resource cleanup**: All Database instances properly closed via try/finally or Mocha lifecycle hooks.
- **Performance**: `Set.has()` behind optional chain is O(1), negligible on hot path.
- **Test quality**: Queries exercise meaningful patterns per rule (WHERE pushdown, subselect filtering, DISTINCT on PK, projection subquery, CSE expressions, join key types, join reorder, correlated IN subquery).
- **Docs**: Added `disabledRules` mention to `docs/optimizer.md` in the Rule Application Control section.

## Testing

- All 20 property tests pass (40 total including existing property.spec.ts)
- Full suite: 1161 passing, 2 pending (unchanged baseline)
- Build clean
