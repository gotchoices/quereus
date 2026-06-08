description: Plan-shape tests asserting optimizer picks expected physical plans
files:
  packages/quereus/test/plan/_helpers.ts
  packages/quereus/test/plan/predicate-pushdown.spec.ts
  packages/quereus/test/plan/join-selection.spec.ts
  packages/quereus/test/plan/aggregate-strategy.spec.ts
  packages/quereus/test/plan/subquery-decorrelation.spec.ts
  packages/quereus/test/plan/cte-materialization.spec.ts
  packages/quereus/test/plan/constant-folding.spec.ts
  packages/quereus/test/plan/index-selection.spec.ts
  packages/quereus/test/plan/README.md
----
Seven plan-shape test files (48 tests total) guarding against optimizer regressions.

**Review fixes applied:**

1. **Extracted shared helpers** (`_helpers.ts`) — `planOps`, `planRows`, `planNodeTypes`, `allRows`,
   `isDescendantOf` were duplicated identically across all 7 files. Now imported from one module.

2. **Fixed tautological assertions** — `join-selection.spec.ts` had `if (hasNLJ) { expect(hasNLJ)... }`
   which always passed. Revealed the optimizer uses generic JOIN (not NestedLoopJoin) for cross joins.
   Updated test to assert a JOIN exists without HashJoin/MergeJoin.

3. **Fixed permissive if/else assertions** in `subquery-decorrelation.spec.ts` — three tests used
   `if (hasJoin) { expect(true) } else { expect(hasExists) }` pattern where the true-branch was
   a tautology. Replaced with direct `expect(hasJoin || hasExists)` matching the pattern already
   used in the NOT EXISTS test.

4. **Updated README** — documented plan-shape tests alongside existing golden-plan tests.

**Post-review fix:**

5. **DRY cleanup in `predicate-pushdown.spec.ts`** — replaced manual `for await` + `any[]` loops
   with the `allRows` typed helper, consistent with all other test files.

**Testing:** 48 plan tests passing, 1915 full suite passing, TypeScript clean.

**Usage:**
```bash
yarn test:plans     # all plan-shape + golden-plan tests
```
