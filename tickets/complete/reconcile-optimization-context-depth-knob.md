---
description: Removed dead `OptimizationContext.withIncrementedDepth()` and the unused `depth` field, leaving `state.depthBudget` in `framework/pass.ts` as the single depth guard.
files:
  - packages/quereus/src/planner/framework/context.ts
  - docs/optimizer.md
---

## Outcome

Two overlapping depth-guard mechanisms collapsed to one. The pass-level
budget in `packages/quereus/src/planner/framework/pass.ts:321-348`
(`depthBudget = max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`
plus `maxRulesFired`) is now the single source of truth for "maximum
optimization depth". The dead context-level path —
`OptimizationContext.depth` + `withIncrementedDepth()` — is gone.

### Final state of `packages/quereus/src/planner/framework/context.ts`

- `OptContext` interface: no `depth` field.
- `OptimizationContext` constructor is 5-arg
  (`optimizer, stats, tuning, phase, db`); log line is
  `Created optimization context (phase: %s)`.
- `withPhase` / `withContext` forward 5 args; tracking-state copy is unchanged.
- `withIncrementedDepth()` deleted.
- `isOptContext` no longer probes `'depth'`.
- Unused imports `StatusCode` and `quereusError` removed.

### `docs/optimizer.md` (≈line 1135–1153, "Context Lifecycle")

The `withIncrementedDepth()` example in the class illustration is gone.
A short paragraph below the code block redirects readers to the
"Pass Framework" section earlier in the doc for the actual depth guard.

## Review findings

Adversarial pass:

- **Dead-code completeness**: `find_references withIncrementedDepth` returns
  only ticket markdown — no source hits. `Grep` for `ctx\.depth|context\.depth`
  across the repo returns nothing. `Grep` for `\.depth\b` in the planner is
  limited to `pass.ts`'s frame-local `depth` (lines 172, 175, 413, 430, 434,
  471, 487, 491) — that's the pass-traversal frame counter, unrelated to the
  removed context field. **Clean.**
- **Constructor compatibility**: `find_references OptimizationContext`
  surfaces only the three internal callsites in `context.ts` itself; the
  build passes, so no external caller is constructing it. The factory
  `createOptContext` and the two `with…` helpers all pass the correct 5 args.
  **Clean.**
- **Tuning surface**: `maxOptimizationDepth` is still meaningful — read in
  `pass.ts:325` as the floor for the input-scaled budget, and exercised by
  `test/optimizer/pass-manager.spec.ts:97-141` ("enforces maxOptimizationDepth
  during pass traversal", with `headroom: 0` to pin the budget to the floor)
  and `test/planner/framework.spec.ts:215-230`. The headroom-scaled budget
  is exercised by `pass-manager.spec.ts:142-180` (200-deep chain passes
  cleanly) and `:184-236` (50,000-deep chain, both traversal orders). **Existing
  coverage adequate; no new tests needed for a deletion.**
- **Type safety**: parameter `phase` has a default but is followed by
  required `db`. TS accepts this (default ≠ optional in the positional
  sense), and the build is clean — confirmed via `yarn build`.
- **Imports**: the implementer correctly removed `StatusCode` and
  `quereusError`. Lint (`yarn workspace @quereus/quereus run lint`)
  exits 0 — no dangling unused-symbol warnings.
- **Docs**: the "Context Lifecycle" rewrite reads naturally; the
  back-pointer to "Pass Framework" is accurate (section header at
  `docs/optimizer.md:101`).
- **Error handling**: nothing to check — the deleted `quereusError` was
  the *only* failure path being removed, and the pass-framework guard at
  `pass.ts:344` (`assertOptimizationDepth`) raises the equivalent error
  with the same `StatusCode.ERROR` for the live path.
- **Resource cleanup / async / cross-platform**: N/A for an interface
  pruning that touches no I/O, no async boundaries, no platform code.
- **Performance**: removing a never-taken branch and one number field;
  no measurable effect.
- **Maintainability / DRY**: the whole point of the change. Two
  divergent depth semantics → one. ✅

Validation:

- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn build` → exit 0, all packages clean (incl. quoomb-web vite bundle).
- `yarn workspace @quereus/quereus run test` → **3175 passing**, no
  failures. Matches the count reported by the implementer.

Skipped:

- `yarn test:store` / `yarn test:full` — the change touches only the
  optimizer framework; no storage code path is exercised by the deleted
  field. The default suite is sufficient (consistent with the
  implementer's noted gap).
- Did not edit `tickets/complete/optimizer-max-depth-wide-where.md`,
  which still mentions `withIncrementedDepth`. Completed tickets are a
  historical record; leaving them intact is correct.

Disposition: **all minor, all fixed by the implementer; no new tickets
filed.**
