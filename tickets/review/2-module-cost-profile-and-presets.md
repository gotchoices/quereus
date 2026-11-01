description: Review the change that replaced a storage module's two loose latency numbers with one optional cost profile plus named presets (memory, local disk, browser storage, network, distributed), read the same way by the engine, the store framework and the isolation wrapper.
prereq: shared-high-latency-test-fixture
files: packages/quereus/src/vtab/cost-profile.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/vtab/cost-profile.spec.ts, packages/quereus/test/optimizer/high-latency-fixture.ts, packages/quereus/test/optimizer/fk-trust-gated-by-capability.spec.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/src/common/cost-profile.ts, packages/quereus-store/src/common/kv-store.ts, packages/quereus-store/src/common/store-module-base.ts, packages/quereus-store/src/common/index.ts, packages/quereus-store/test/cost-profile.spec.ts, packages/quereus-store/test/expected-latency-plan.spec.ts, docs/optimizer-costing.md, docs/module-capabilities.md, docs/module-authoring.md, docs/optimizer-parallel.md, docs/optimizer-joins.md, docs/runtime-parallel.md, packages/quereus-store/README.md, packages/quereus-isolation/README.md
----
# Module cost profile with named presets — review handoff

## What landed

`VirtualTableModule.expectedLatencyMs` / `expectedRowLatencyMs` are gone (no alias). A module now declares `readonly costProfile?: ModuleCostProfile` = `{ firstRowLatencyMs?, perRowLatencyMs? }`, wall-clock ms, omitted = 0.

- `packages/quereus/src/vtab/cost-profile.ts` (new): `ModuleCostProfile`, `ResolvedModuleCostProfile`, frozen `COST_PRESETS` (numbers exactly as the plan's table), `resolveModuleCostProfile(declared, warn?)` — undefined → 0, `0` accepted, negative / NaN / ±Infinity → 0 plus one `warn` call per bad field naming it. All four exported from `src/index.ts`.
- `SchemaManager.registerModule` resolves once with `warnLog('Module %s: %s', name, msg)` (result discarded — it exists to report).
- `TableReferenceNode.computePhysical` lifts the resolved profile into the unchanged physical-property names `expectedLatencyMs` / `expectedRowLatencyMs`, each only when `> 0` — so memory leaves still omit the keys and the `test/plan` goldens are byte-identical. Comment there marks it as the one place declaration meets subtree estimate.
- Comment sweep: `plan-node.ts` (both property docs), `cost/index.ts` (`latencyCost` doc + `indexNestedLoopJoinCost` NOTE now says "declare the preset for your category"), `optimizer-tuning.ts` (`latencyCostPerMs`), `rule-join-physical-selection.ts` (`readMs`), `rule-fanout-batched-outer.ts` NOTE, `rule-eager-prefetch-probe.ts` and `rule-fanout-lookup-join.ts` header docs. Sites that read the *subtree* property (`index-nested-loop.ts`, `rule-nested-loop-right-cache.ts` NOTE, quickpick NOTE, parallel rules, tuning `parallel.*` docs) were left as they are on purpose.
- Isolation: one live getter `get costProfile(): ModuleCostProfile` returns `underlying.costProfile ?? {}`; old two getters removed. Spec stub `modeStub` now sets `costProfile: { firstRowLatencyMs }`; the three getter assertions read `iso.costProfile`.
- Store: `KVCostProfile extends ModuleCostProfile`; `ResolvedCostProfile = Required<KVCostProfile>` so `PARITY_COST_PROFILE` now also carries `firstRowLatencyMs: 0, perRowLatencyMs: 0`. `resolveCostProfile` spreads `resolveModuleCostProfile(profile, msg => console.warn('[StoreModule] provider ' + msg))` then resolves the ratios as before (`resolveCostField` now typed to the ratio keys only). `LatencyField` / `resolveExpectedLatencyMs` deleted (and their export). `KVStoreProvider.expectedLatencyMs` / `expectedRowLatencyMs` deleted, docs folded into `costProfile`. `StoreModuleBase.costProfile` is now public `readonly` and satisfies the engine field directly; its two latency fields are gone.
- Plugins: the LevelDB and IndexedDB provider `NOTE:`s had the removed field names renamed to the profile fields — wording otherwise untouched (the next ticket, `store-providers-adopt-cost-presets`, rewrites those sites).

## Tests

- **Added** `packages/quereus/test/vtab/cost-profile.spec.ts` — the resolver rule: each of -1 / NaN / Infinity in either field → 0 with exactly one warning naming that field (the other field kept); `0` silent; undeclared → zeros silent; `COST_PRESETS.memory` resolves equal to undeclared.
- **Changed** `test/optimizer/high-latency-fixture.ts` and the private `HighLatencyOrphanMemoryModule` in `fk-trust-gated-by-capability.spec.ts` to declare `costProfile`. No assertion changes.
- **Changed** `quereus-store/test/expected-latency-plan.spec.ts`: provider declares `costProfile: { firstRowLatencyMs }` (via `createInMemoryProvider({ costProfile })`); resolution asserts read `new StoreModule(p).costProfile.firstRowLatencyMs`; the unusable-value and "0 is valid" cases removed (now owned by the engine resolver spec). Plan-level assertions (batched fan-out at 30 ms, none at 0, same rows, per-row → seek) kept unchanged.
- **Changed** `quereus-store/test/cost-profile.spec.ts`: the `resolveCostProfile` deep-equal expectations spread a `NO_LATENCY` zero pair, because the resolved shape grew two fields. Not in the ticket's list; mechanical consequence of `ResolvedCostProfile = Required<KVCostProfile>`.

## Validation run (all from repo root, foreground)

`yarn lint` clean · `yarn typecheck` clean · `yarn build` clean · `yarn test` all green (engine 10,865 passing / 25 pending; every other workspace passing) · `yarn bench:gate` 56 match / 0 differs, ratio guards hold · `yarn docs:check` OK. No `test/plan/**/*.plan.json` changed. `yarn test:store` not run (no provider adopts a preset here — next ticket's concern).

## Things to look at / known gaps

- **`docs/module-authoring.md` is 9 words under its 12,000-word cap** (11,944 before → 11,991). The planned "Declaring a cost profile" section therefore shrank to a three-sentence pointer; the paging-to-per-row derivation, the worked example and the "hint never affects correctness" line live in `docs/optimizer-costing.md` § Module cost profile ("**Paging backends.**" paragraph) instead. The next edit to module-authoring will have to split it.
- **Double resolution of a store module's profile.** `StoreModuleBase` resolves at construction (warns via `console.warn`), and `registerModule` resolves the already-clean result again (no second warning possible). Harmless; noted in case a reviewer wants the registration path to skip pre-resolved modules.
- **Isolation getter returns the underlying's whole object**, so a wrapped `StoreModule` exposes its ratios through the wrapper too. Nothing reads them there.
- **A provider class field still spelled `expectedLatencyMs`** compiles silently (excess-property checks only catch object literals). As the plan accepted — no in-tree provider declares one; the next ticket touches all four.
- `module-capabilities.md`'s new `costProfile` row names `store-providers-adopt-cost-presets` in its plugins column, matching the plan's wording; drop the slug once that ticket lands.
- The isolation `costProfile` getter has no nested-wrapper test (recursion by construction, as the plan decided).

## Usage

```ts
import { COST_PRESETS } from '@quereus/quereus';
class RemoteModule extends MemoryTableModule {
	readonly costProfile = { ...COST_PRESETS.network, perRowLatencyMs: 0.02 };
}
// store provider:
const provider: KVStoreProvider = { ..., costProfile: { ...COST_PRESETS.localDisk, pointRead: 2 } };
```
