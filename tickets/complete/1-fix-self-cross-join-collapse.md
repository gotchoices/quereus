description: Self CROSS JOIN column-name collapse — fixed via duplicate-name guard in identity-projection check
prereq:
files:
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
----

## Summary

`select A.*, B.* from t1 as A cross join t1 as B` (and the bare `select * from t1 as A cross join t1 as B`) used to silently collapse to one side's columns. The cartesian product was correct in the join itself, but the `ProjectNode` that would normally apply `name:N` disambiguation was being elided by an over-eager identity-projection optimization. With no `ProjectNode`, the engine surfaced the JoinNode's raw columns `[a, b, a, b]`; downstream row→object conversion collapsed the duplicates.

## What was changed

`packages/quereus/src/planner/building/select-modifiers.ts` — `isIdentityProjection` now returns `false` when the source's attribute names contain any case-insensitive duplicates, forcing a `ProjectNode` whose `outputTypeCache` already implements the `name:N` rule (`packages/quereus/src/planner/nodes/project-node.ts:47-83`). This is a one-time O(n) scan over source attrs at build time — no runtime cost. The pass-through optimization remains active for the common cases (single-source `SELECT *`, joins of differently-named tables).

The fix was implemented as part of the related `fix-using-clause-select-star` ticket (commit `721a5a95`), which converged on the same root cause; this ticket then re-enabled the previously disabled regression tests.

`packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` — re-enabled the two `-- TODO bug:` cases:

- `select A.a as la, B.a as ra from t1 as A cross join t1 as B order by la, ra` → 4-row cartesian
- `select A.*, B.* from t1 as A cross join t1 as B order by A.a, B.a` → `[a, b, a:1, b:1]` × 4 rows

## Validation

- `yarn build` — clean.
- `yarn test --grep "01.1-select-projection-extras"` — passes.
- All 184 sqllogic tests pass.
- Existing test failure in `test/optimizer/extended-constraint-pushdown.spec.ts` (`handles OR with range predicate as residual correctly`) is unrelated to this change — it concerns OR-predicate constraint pushdown, a separate code path that this ticket does not touch.

## Usage / regression coverage

- `select A.*, B.* from t1 as A cross join t1 as B` → distinct columns `[a, b, a:1, b:1]`.
- `select A.a as la, B.a as ra from t1 as A cross join t1 as B` → preserved as regression coverage (already worked because explicit aliases differ from source attr names).
- `select *, * from t1` → unchanged: still goes through `ProjectNode` because projection length differs from source-attr count.
- `select * from t1` → unchanged: still elides `ProjectNode` (no duplicate names → fast path retained).

## Review notes

- The new guard is the minimal change that resolves the bug. It makes `isIdentityProjection` strictly more conservative; correctness is preserved (returning `false` from a perf-only optimization can never produce wrong results).
- No other code path was identified where same-named source columns could reach row→object materialization without a wrapping `ProjectNode` — every `SELECT` in the planner flows through `buildFinalProjections`, including subqueries, CTEs, view bodies, INSERT-SELECT, and UNION children.
- No documentation update needed; this is an internal planner optimization not surfaced in any user-facing doc.
