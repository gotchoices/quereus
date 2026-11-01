description: A storage module now declares one optional cost profile (first-row and per-row latency) instead of two loose latency numbers, with named presets for memory, local disk, browser storage, network and distributed storage, read the same way by the engine, the store framework and the isolation wrapper.
prereq: shared-high-latency-test-fixture
files: packages/quereus/src/vtab/cost-profile.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/vtab/cost-profile.spec.ts, packages/quereus/test/optimizer/high-latency-fixture.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/src/common/cost-profile.ts, packages/quereus-store/src/common/kv-store.ts, packages/quereus-store/src/common/store-module-base.ts, packages/quereus-store/test/expected-latency-plan.spec.ts, docs/optimizer-costing.md, docs/module-capabilities.md, docs/module-authoring.md, docs/optimizer-joins.md, docs/optimizer-parallel.md, docs/runtime-parallel.md, packages/quereus-store/README.md, packages/quereus-isolation/README.md
----
# Module cost profile with named presets — complete

## What landed

Implemented in `ticket(implement): module-cost-profile-and-presets`.

`VirtualTableModule.expectedLatencyMs` / `expectedRowLatencyMs` are gone (no alias). A module declares `readonly costProfile?: ModuleCostProfile` = `{ firstRowLatencyMs?, perRowLatencyMs? }` — wall-clock milliseconds, omitted = 0, a plan-choice hint only.

- `packages/quereus/src/vtab/cost-profile.ts`: `ModuleCostProfile`, `ResolvedModuleCostProfile`, frozen `COST_PRESETS` (`memory` 0/0, `localDisk` 0.05/0.004, `browserIdb` 1/0.01, `network` 40/0.04, `distributed` 100/0.2), and `resolveModuleCostProfile(declared, warn?)` — the one reading rule (undefined → 0; `0` valid; negative / non-finite → 0 with one warning per bad field). All exported from `@quereus/quereus`.
- `SchemaManager.registerModule` resolves once with a warning sink naming the module; `TableReferenceNode.computePhysical` resolves silently and lifts each latency onto the unchanged subtree properties `expectedLatencyMs` / `expectedRowLatencyMs` only when positive, so memory-backed plan goldens are byte-identical.
- Isolation: one live getter `costProfile` forwarding `underlying.costProfile ?? {}`.
- Store: `KVCostProfile extends ModuleCostProfile` (latencies + the store-only `pointRead` / `seekPositioning` ratios); `StoreModuleBase.costProfile` is public and is the engine field; `KVStoreProvider.expectedLatencyMs` / `expectedRowLatencyMs`, `resolveExpectedLatencyMs` and `LatencyField` deleted.
- Docs: `optimizer-costing.md` § Module cost profile carries the preset table with sources, the paging-backend derivation and the declaration-versus-estimate split; capability matrix, parallel/joins/runtime docs and both package READMEs updated.

No in-tree provider adopts a preset yet — that is `store-providers-adopt-cost-presets` (in `implement/`), which also gates on `yarn test:store`.

## Usage

```ts
import { COST_PRESETS } from '@quereus/quereus';
class RemoteModule extends MemoryTableModule {
	readonly costProfile = { ...COST_PRESETS.network, perRowLatencyMs: 0.02 };
}
// store provider:
const provider: KVStoreProvider = { ..., costProfile: { ...COST_PRESETS.localDisk, pointRead: 2 } };
```

## Review findings

Read the implement diff first, then the handoff; ran lint, build, typecheck, `docs:check` and the full `yarn test` after the fixes below (all green; engine 10,864 passing / 25 pending — one fewer than the handoff because of the test cut below; every other workspace passing). `yarn test:store` not run: no provider declares a non-zero profile in this change, so the store path plans as before; the next ticket owns that gate.

**Fixed in this pass (minor):**
- **Presets carried literal number types.** `Object.freeze({...})` infers literal types (`firstRowLatencyMs: 0.05`), so `class A { readonly costProfile = COST_PRESETS.localDisk }` followed by a subclass redeclaring `costProfile = COST_PRESETS.network` failed to compile (verified with a scratch file: TS2416). Each preset is now `Object.freeze<ResolvedModuleCostProfile>(...)` (plain `number` fields), the redundant `as const satisfies` dropped, and the doc comment says why.
- **Stale doc:** `docs/optimizer-joins.md` (fan-out cost gate bullet) still told remote plugins to populate `VirtualTableModule.expectedLatencyMs`; now points at `costProfile.firstRowLatencyMs` and the leaf lift.
- **Comment hygiene:** re-wrapped five comment lines the rename had pushed far past the file's width (`isolation-module.ts` concurrencyMode doc, store `PARITY_COST_PROFILE` doc, `rule-join-physical-selection.ts` `readMs` doc, `rule-fanout-batched-outer.ts` NOTE, `join-latency-cost.spec.ts` header).
- **Test cut:** `resolves the memory preset equal to declaring nothing` in `test/vtab/cost-profile.spec.ts` only compared a constant against zeros; removed. The remaining resolver cases (each bad value in each field, `0` silent, undeclared silent) pin real branching and stay.

**Checked, nothing to do:**
- Correctness of the leaf lift: the old `typeof`/`isFinite`/`> 0` guard is fully covered by `resolveModuleCostProfile` plus the `> 0` check; a non-number from untyped JS (string, `null`) fails `Number.isFinite` and reads as 0.
- Store resolution: an undeclared provider still returns the shared frozen `PARITY_COST_PROFILE` (now with zero latencies); a latency-only declaration keeps parity ratios; ratio and latency warnings stay independent. Double resolution (store constructor, then `registerModule`) cannot double-warn — the second pass sees clean values.
- Isolation forwarding: live getter, overlay ignored, `{}` satisfies `exactOptionalPropertyTypes`; `createIsolatedStoreModule` therefore exposes the store's ratios too, which nothing reads at that level — harmless.
- `registerModule` now reads `costProfile` at registration; every in-tree getter (isolation) is safe to read before connect.
- Leftover old names: grepped source, tests, docs and READMEs — remaining `expectedLatencyMs` / `expectedRowLatencyMs` hits are all the subtree physical properties, which keep those names on purpose. The one stale backlog mention (`feat-indexeddb-declares-its-read-latency`, "declare `expectedLatencyMs` and `expectedRowLatencyMs`") is in the next ticket's explicit scope to trim, so left for it.
- Performance: `computePhysical` now allocates one small object per leaf per physical computation; negligible next to the rest of that method, no tripwire warranted.
- Docs size: `docs/module-authoring.md` sits just under its 12,000-word cap (handoff measured 11,991); `docs:check` passes. Nothing to file — the checker already forces the split on the next addition.

**Tripwires / tickets:** none filed. The handoff's "provider class field still spelled `expectedLatencyMs` compiles silently" is a one-time migration hazard the next ticket closes for all in-tree providers; no class-level invariant beyond excess-property checking applies. `module-capabilities.md`'s `costProfile` row names `store-providers-adopt-cost-presets` in its plugins column — that ticket rewrites the cell.
