description: Twelve test files each keep their own private copy of the same fake "slow storage" table type used to exercise the planner's latency rules; move it into one shared test helper so the next change to how a module declares its latency touches one file instead of twelve.
files: packages/quereus/test/optimizer/high-latency-fixture.ts (new), packages/quereus/test/optimizer/parallel-async-gather.spec.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/fk-trust-gated-by-capability.spec.ts, packages/quereus/test/optimizer/inclusion-dependencies.spec.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/test/optimizer/set-op-row-estimates.spec.ts, packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts, packages/quereus/src/planner/optimizer-tuning.ts
difficulty: easy
----

# One shared slow-storage test fixture

Absorbs `backlog/debt-shared-high-latency-test-module` (deleted on promotion). It is the first link of the module-cost-profile chain: the next ticket (`module-cost-profile-and-presets`) changes *how* a module declares its latency, and with this landed that change touches one fixture file instead of twelve.

## What exists

Several planner rules switch on only when a storage module reports that its tables are slow to hand back a first row: the three parallel rules (`rule-async-gather-union-all`, `rule-async-gather-zip-by-key`, `rule-eager-prefetch-probe`), the batched-outer flip (`rule-fanout-batched-outer`), the fan-out recognition rule, and the latency charges in `rule-join-physical-selection`. No in-tree module is slow, so the tests fake one: a `MemoryTableModule` subclass that declares `expectedLatencyMs = 25`.

`grep -rn "expectedLatencyMs = 25" packages/quereus/test` lists every copy — twelve spec files at the time of writing (the ten the backlog ticket named plus `set-op-row-estimates.spec.ts` and `index-nested-loop-batched.spec.ts`). `join-latency-cost.spec.ts` also carries a second variant with a per-row rate (`expectedRowLatencyMs = 1`). The doc comments above the copies have drifted; one calls itself "the synthetic remote-vtab stand-in used by every parallel/latency optimizer spec" while being one private copy among twelve.

The number 25 is not arbitrary: it equals the default of the three wall-clock gates in `optimizer-tuning.ts` (`batchedOuterThresholdMs`, `gatherThresholdMs`, `prefetchProbeThresholdMs`), so the fixture sits exactly *at* the `>=` gates. Nothing ties the two together today.

## What to build

One helper module, `packages/quereus/test/optimizer/high-latency-fixture.ts`, exporting:

- `HIGH_LATENCY_MS` — the fixture's first-row latency, defined as `DEFAULT_TUNING.parallel.gatherThresholdMs` (import `DEFAULT_TUNING`, do not restate `25`), with a one-line assertion or comment that the three gates share that default so the fixture clears all of them.
- `HighLatencyMemoryModule` — `MemoryTableModule` with `expectedLatencyMs = HIGH_LATENCY_MS`.
- `PerRowLatencyMemoryModule` — the same first-row delay plus `expectedRowLatencyMs = 1` (today only `join-latency-cost.spec.ts` declares this shape; export it from the helper so the next ticket changes it in one place).

Every spec imports from the helper and deletes its private class. Keep each spec's own explanatory comment about *why that spec* needs latency where it adds something; delete the drifted general descriptions in favour of the helper's one doc comment.

The `quereus-store` package's `expected-latency-plan.spec.ts` builds a slow key-value *provider*, not a fake table type; it stays where it is (the next ticket rewrites it anyway). Do not add a cross-package helper for it.

## Edge cases & interactions

- Behaviour of every existing test is unchanged — verified by `yarn workspace @quereus/quereus test` passing with no assertion edits. If a spec needs an edit beyond the import swap, stop and look: a copy had drifted in value, not only in comment.
- Keep the helper out of the `test/plan/` golden sweep's module registry: the goldens run on plain `MemoryTableModule` and must not pick up a 25 ms fixture.
- `yarn lint` in `packages/quereus` type-checks test files (`tsconfig.test.json`); the helper must be inside that config's `include`.

## TODO

- [ ] Create `test/optimizer/high-latency-fixture.ts` with the two classes and the gate-derived constant
- [ ] Swap every private copy for the import (grep `expectedLatencyMs = 25` and `expectedRowLatencyMs = 1` under `packages/quereus/test`); confirm the grep returns only the helper afterwards
- [ ] Run `yarn workspace @quereus/quereus test` and `yarn lint` from the repo root
- [ ] Delete `tickets/backlog/debt-shared-high-latency-test-module.md` (absorbed here)
