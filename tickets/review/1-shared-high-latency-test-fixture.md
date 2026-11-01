description: Twelve optimizer test files each kept a private copy of the same fake "slow storage" table type; they now share one test helper, so the next change to how a module declares its latency touches one file.
files: packages/quereus/test/optimizer/high-latency-fixture.ts (new), packages/quereus/test/optimizer/parallel-async-gather.spec.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/fk-trust-gated-by-capability.spec.ts, packages/quereus/test/optimizer/inclusion-dependencies.spec.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/set-op-row-estimates.spec.ts, packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts, packages/quereus/src/planner/optimizer-tuning.ts
difficulty: easy
----

# One shared slow-storage test fixture — review handoff

Absorbs `debt-shared-high-latency-test-module` (its backlog file was already gone at implement time). First link of the module-cost-profile chain; `module-cost-profile-and-presets` follows.

## What changed

- New `test/optimizer/high-latency-fixture.ts` exports:
  - `HIGH_LATENCY_MS = DEFAULT_TUNING.parallel.gatherThresholdMs` (no restated `25`); doc comment notes the three wall-clock gates (`batchedOuterThresholdMs`, `gatherThresholdMs`, `prefetchProbeThresholdMs`) share that default so the fixture clears all three `>=` gates.
  - `HighLatencyMemoryModule` (`expectedLatencyMs = HIGH_LATENCY_MS`).
  - `PerRowLatencyMemoryModule` (same plus `expectedRowLatencyMs = 1`).
- All twelve specs import from the helper; private classes and their drifted general doc comments deleted. `MemoryTableModule` import dropped where no longer used.
- `filter-selectivity.spec.ts`: kept its spec-specific comment (why restamp needs the gather), reworded its "synthetic module below" reference.
- `fk-trust-gated-by-capability.spec.ts`: `HighLatencyOrphanMemoryModule` (extends a local orphan-permitting module, so can't be the shared class) stays local but uses `HIGH_LATENCY_MS`.
- `optimizer-tuning.ts`: three comments that said "matches the synthetic high-latency vtab fixture" now name the fixture. Comments near lines 209/220/359 still say "high-latency vtab fixture" generically — accurate, left alone.
- Helper isn't a `.spec.ts`, so mocha doesn't load it as a suite; not referenced by `test/plan/` goldens.

`grep -rn "expectedLatencyMs = 25\|expectedRowLatencyMs = 1" packages/quereus/test` now returns only the helper's `expectedRowLatencyMs = 1`; the `25` literal is gone from tests.

## Validation

- `yarn workspace @quereus/quereus test`: 10859 passing, 25 pending, no assertion edits.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`): exit 0. Helper is under `test/**/*`, inside that config's include.

## Tests

None added — pure test-code refactor; existing suite is the check.

## Gaps / reviewer notes

- Gate equality is documented in a comment, not asserted; if one gate default changes, the fixture tracks only `gatherThresholdMs`. Next ticket reshapes this anyway.
- `quereus-store`'s `expected-latency-plan.spec.ts` untouched by design.
