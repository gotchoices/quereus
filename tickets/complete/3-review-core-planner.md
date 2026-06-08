---
description: Review + hardening of planner scope resolution, ambiguity handling, and window typing
prereq: none

---

## Summary

Focused adversarial review and fixes around planner name resolution and typing, targeting correctness risks that would leak into optimizer/runtime behavior.

### Key changes

- **Scope semantics clarified**
  - `MultiScope` is now **peer-scope** only: unqualified names that resolve in more than one peer resolve to `Ambiguous`.
  - Added `ShadowScope` (`packages/quereus/src/planner/scopes/shadow.ts`) for **layered shadowing** (first match wins).
  - `MultiScope` avoids false ambiguity for **qualified names**, **parameters**, and **functions** (prevents double-resolving stateful `?` params).

- **Planner builders updated**
  - SELECT layering now uses `ShadowScope` so projection aliases / window output can shadow prior scopes without triggering join-style ambiguity.
  - Removed unused scope monkey-patch for CTE references.
  - FROM subquery/mutating-subquery sources no longer crash if alias is absent (plan still builds with unqualified access).

- **Error reporting**
  - `Ambiguous` column resolution now throws `ambiguous column name: <name>` (instead of being misreported as “not found”).

- **Window function typing**
  - `WindowFunctionCallNode` now uses `WindowFunctionSchema.returnType` (via `resolveWindowFunction`) rather than hardcoded numeric defaults.

### Tests added/extended

- `packages/quereus/test/logic/90-error_paths.sqllogic`
  - JOIN ambiguity error
  - qualified JOIN columns succeed
  - projection alias shadowing in `order by`
  - CTE name shadowing table name
- `packages/quereus/test/planner/window-function-types.spec.ts`
  - asserts ranking + aggregate window functions use schema return types

### Validation

- `yarn test` (package `packages/quereus`) passes.

## Notes / follow-ups

- Consider adding a plan-time validator for **duplicate attribute IDs** across join/CTE compositions (defensive invariant).

