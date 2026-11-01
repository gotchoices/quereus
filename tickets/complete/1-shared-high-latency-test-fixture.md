description: Twelve optimizer test files each kept a private copy of the same fake "slow storage" table type; they now share one test helper, so the next change to how a module declares its latency touches one file.
files: packages/quereus/test/optimizer/high-latency-fixture.ts (new), packages/quereus/test/optimizer/parallel-async-gather.spec.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/fk-trust-gated-by-capability.spec.ts, packages/quereus/test/optimizer/inclusion-dependencies.spec.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/set-op-row-estimates.spec.ts, packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts, packages/quereus/src/planner/optimizer-tuning.ts, docs/optimizer-parallel.md
difficulty: easy
----

# One shared slow-storage test fixture

Absorbed `debt-shared-high-latency-test-module`. First link of the module-cost-profile chain; `module-cost-profile-and-presets` follows.

## Summary

`test/optimizer/high-latency-fixture.ts` exports `HIGH_LATENCY_MS` (= `DEFAULT_TUNING.parallel.gatherThresholdMs`), `HighLatencyMemoryModule` and `PerRowLatencyMemoryModule`. All twelve optimizer specs import it; their private copies are gone. `fk-trust-gated-by-capability.spec.ts` keeps a local `HighLatencyOrphanMemoryModule` (different base class) using `HIGH_LATENCY_MS`. Comments in `optimizer-tuning.ts` name the fixture file.

## Review findings

- **Diff read** (`ticket(implement): shared-high-latency-test-fixture`): mechanical, every removed class had `expectedLatencyMs = 25` (and one `expectedRowLatencyMs = 1`), matching the helper exactly. No behaviour change; spec-specific comments preserved where they said something the helper doesn't.
- **Docs — fixed:** `docs/optimizer-parallel.md` lines 19 and 79 pointed at the fixture in `parallel-async-gather.spec.ts`, which no longer exists there; now name `test/optimizer/high-latency-fixture.ts`. `docs/optimizer-joins.md` cites `expectedLatencyMs = 25` as a worked-example input, not a fixture pointer — accurate, left alone.
- **Tripwire — parked:** `HIGH_LATENCY_MS` derives from the gather threshold, but `join-latency-cost.spec.ts` hand-computes cost comparisons from 25 ms. Fine now (all equal); if the gather default moves, those worked numbers shift. `NOTE:` added on `HIGH_LATENCY_MS` in the fixture. Gate equality (three thresholds share 25) remains comment-only, as the implementer flagged; the follow-on ticket reshapes this.
- **Out of scope, noted:** `packages/quereus-isolation/test/isolation-layer.spec.ts:4706` has its own `HighLatencyMemoryModule` copy. Different package, can't import quereus test helpers without cross-package test coupling; left alone. `quereus-store`'s `expected-latency-plan.spec.ts` untouched by design.
- **Tests:** none added or cut — pure test refactor, existing suite is the check. Helper isn't `*.spec.ts`, so mocha doesn't load it as a suite.
- **Type safety / hygiene / resource cleanup / performance:** nothing to find — 33-line helper, no `any`, no runtime code touched.
- **Validation:** `yarn workspace @quereus/quereus run lint` exit 0; `yarn workspace @quereus/quereus test` 10859 passing, 25 pending.
