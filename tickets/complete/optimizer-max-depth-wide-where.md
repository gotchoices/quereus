---
description: Scale the optimizer's per-pass depth budget with the input plan's measured depth so wide-WHERE / deep-CASE inputs no longer trip the depth guard; add a separate `maxRulesFired` budget that catches runaway rule rewrites independent of input shape.
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
  - packages/quereus/test/planner/framework.spec.ts
  - packages/quereus/test/performance-sentinels.spec.ts
  - docs/optimizer.md
---

## Summary

Implemented Option A from the original ticket. Two new `OptimizerTuning` fields:

- `optimizationDepthHeadroom` (default `16`) — added to measured input depth.
- `maxRulesFired` (default `100000`) — per-pass cap on successful rewrites.

`maxOptimizationDepth` is preserved as a floor. The effective per-pass budget is
`max(maxOptimizationDepth, planInputDepth(plan) + optimizationDepthHeadroom)`, computed once at pass entry and carried in pass-local `PassState`.

A new iterative `planInputDepth` walks the input shape without using the call stack. `applyPassRules` increments `state.rulesFired` on each successful rewrite and throws if it exceeds `state.maxRulesFired`.

Sentinel `Performance sentinels > Planning time > plans a 50-column SELECT…` restored to the original 50 conjuncts × 50 columns target (was shrunk to 25 as a workaround). Existing depth-guard tests now opt-in to `optimizationDepthHeadroom: 0` so they still exercise the guard on deliberately-too-deep inputs.

## Review findings

### Validation run
- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, no output).
- `yarn workspace @quereus/quereus run test` — **3169 passing, 0 failing**.
- Pre-existing `@quereus/sample-plugins` failures (`key_value_store > supports delete/update`) reproduce on `main` and are out of scope here. Worth a separate ticket but not blocking this review.

### Code review — what was checked

**Correctness of the budget formula.** `executeStandardPass` computes the budget once per pass against the *current* plan (i.e. the output of the previous pass becomes the input to the next), which is the right granularity — if a structural pass deepens the tree, subsequent passes get a budget that reflects reality. The floor (`maxOptimizationDepth`) correctly keeps shallow-input behaviour identical to historic. **OK.**

**Iterative `planInputDepth`.** Uses an explicit worklist stack — correctly avoids JS call-stack growth on the very inputs it is measuring. Visits each node exactly once and tracks `maxDepth` as the running maximum of `top.depth` rather than only at leaves, so it is correct even for nodes with mixed-arity children. **OK.**

**`maxRulesFired` semantics.** Counts only *successful* rewrites (`result && result !== currentNode`), not failed match attempts or no-op rules. Pass-local (resets between passes). Check is `state.rulesFired > state.maxRulesFired` (strict), so a budget of N allows exactly N firings and trips on the N+1th — consistent with the error message wording. The doc-comment on the tuning field says "generously sized so it only trips on stuck rules", which matches the intent. **OK.**

**Per-pass vs cumulative tracking.** The implementer flagged this as a deliberate choice. Per-pass means the 5-pass standard optimizer can fire 5×100k = 500k total in the worst case. For a "stuck rule" detector this is fine — a stuck rule trips its own pass and never reaches the next one. Cumulative tracking would offer a tighter total-time guarantee but at the cost of cross-pass coupling. The chosen design matches the other per-pass scratch state (`optimizedNodes.clear()` between passes). **OK as-is.**

**Visited-rule inheritance interaction with `rulesFired`.** Walked the loop in `applyPassRules`: after a firing, `inheritVisitedRules` copies the original's visited set (including the just-added rule mark) to the new node's id. On the next for-loop iteration the rule is correctly skipped via `hasRuleBeenApplied(result.id, rule.id)` — so a single logical node still fires each rule at most once, and the implementer's note about the test using a long chain (rather than a ping-pong cycle) is accurate. **OK.**

**Test edits to existing depth-guard tests.** Both `pass-manager.spec.ts:131` and `framework.spec.ts:227` now pass `optimizationDepthHeadroom: 0`. Sanity-checked: the guard still fires on the same trees (20-deep with cap 5; 5-deep with cap 3). The edits read as "still testing the guard works, with the new field set so the guard is what bounds the budget" — not as "watered down". **OK.**

**Restored 50×50 sentinel.** Threshold lifted 5000 ms → 10000 ms for the larger workload. Comment now points at `planInputDepth` rather than the old fixed-50 ceiling. With CI headroom this is comfortable; on local Node the test ran inside the existing 1-minute test budget. **OK.**

**Docs.** `docs/optimizer.md` § "Pass Framework" bullet on depth safety was updated. **OK** — though the `OptimizationContext.withIncrementedDepth()` doc section further down (~line 1144) still references the old single-knob semantics. That's the same "two depth-guard mechanisms" inconsistency the implementer flagged in `context.ts`. Tracked as a follow-up (see below).

### Issues found and disposition

1. **Type-level breaking change to `OptimizerTuning`.** Two new required `readonly` fields. External consumers constructing an `OptimizerTuning` literal would fail to compile. Mitigations in-tree: `DEFAULT_TUNING` is updated; the only construction sites I could find spread an existing tuning (`database.ts:204`, `database.ts:1036`) or cast partials for tests (`basic-estimates.spec.ts:6`, `basic-estimates.spec.ts:199`). All compile. No external consumers in this monorepo construct from scratch. **Minor; no action.** Marked here so it's not invisible if external embedders bump the version.

2. **Doc inconsistency in `docs/optimizer.md` around the `withIncrementedDepth()` example.** The example block at ~line 1144 still illustrates the *old* single-knob check. Implementer's note about `OptimizationContext.withIncrementedDepth()` being out-of-scope is fair (the method is unused outside `context.ts`). But the doc snippet showing it as the canonical depth-check example will confuse readers given the framework's new two-knob design. **Minor — fixed inline** (see edit below).

3. **Default headroom of 16 is an educated guess.** Implementer flagged this. I read every rule under `src/planner/rules/**` for "deepening by K cascades" patterns; none jumped out as obviously consuming more than a handful of frames over the input depth in a single visit. 16 looks defensible. **No action; explicit follow-up if a real plan trips the new budget.**

4. **Default `maxRulesFired: 100000` is empirically uncalibrated.** Also flagged by the implementer. Per-pass over typical plans is far below 100k; runaway rules trip it via shape (the new test does so with 200 firings vs a 50 budget). The current value buys generous safety margin. **No action; revisit if a legitimate workload ever brushes it.**

5. **Stack-overflow risk on inputs deeper than V8's JS stack (~10–20k frames).** `traverseTopDown` / `traverseBottomUp` are still recursive. Pre-existing — but the new headroom regime can let inputs >50 frames through where the old hard cap stopped them. The new 200-deep test runs well inside V8's stack limit so the test suite is safe, and `planInputDepth` is iterative so the *measurement* path is safe even on pathological inputs. The recursive traversal itself is still vulnerable to a 10k-deep adversarial input. Implementer notes this as a layered Option-B follow-up. **Major-shaped but rare — filed as a follow-up ticket** (see below).

6. **The pre-existing `OptimizationContext.withIncrementedDepth()` is still wired to raw `maxOptimizationDepth`.** Implementer flagged it. It's unused outside `context.ts`, so semantically dead, but its continued existence creates two competing "depth guard" mechanisms with different meanings of `maxOptimizationDepth`. **Filed as follow-up** to either delete it or reconcile.

### Categories explicitly checked

- **SPP / DRY** — the two new fields and `PassState` are declared once and threaded through; no duplicate logic. **Clean.**
- **Modularity** — `planInputDepth` is a free function; `PassState` is private to `pass.ts`. Cross-file API surface unchanged. **Clean.**
- **Scalability** — `planInputDepth` is O(n) shape-only; runs once per pass. Worklist allocation is per-node `{node, depth}`; fine for realistic plan sizes. **Acceptable.**
- **Maintainability** — doc comments on the tuning fields explain the formula. Pass-state object is self-documenting. The depth-error message now includes the budget for diagnosis. **Improved over before.**
- **Performance** — iterative measurement is cheap; per-pass recomputation is a defensible trade vs. memoization. Test suite ran in ~1m, indistinguishable from baseline. **No regression.**
- **Resource cleanup** — `PassState` is per-call, GC'd at pass end. No leaks. **Clean.**
- **Error handling** — both throws use `quereusError` with `StatusCode.ERROR`; messages identify which budget tripped (`maxRulesFired` vs depth). **Clean.**
- **Type safety** — no `any`; `PassState` interface is explicit. **Clean.**
- **Edge cases** — empty children list, top-down vs bottom-up symmetry, zero-headroom guard, cumulative cross-pass behaviour: all covered by the existing + new tests.
- **Regressions** — none surfaced in the 3169 quereus tests; pre-existing sample-plugins failures reproduce on main.

### Inline fixes applied during review

- `docs/optimizer.md` `withIncrementedDepth()` example block: added a one-line note clarifying that this is a legacy single-knob check superseded for pass traversal by the budget formula in `pass.ts`.

### Follow-up tickets filed

- `iterative-traversal-deep-plan-stack-overflow.md` (backlog) — Option-B layering: convert `traverseTopDown` / `traverseBottomUp` to iterative worklists so inputs deeper than V8's stack don't blow up under the new headroom regime.
- `reconcile-optimization-context-depth-knob.md` (backlog) — delete or reconcile `OptimizationContext.withIncrementedDepth()` with the new pass-level budget so `maxOptimizationDepth` has one meaning.
