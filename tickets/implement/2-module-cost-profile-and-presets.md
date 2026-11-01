description: Replace the two loose latency numbers a storage module can declare with one optional cost profile and a set of named presets (memory, local disk, browser storage, network, distributed), so a module author picks the category of storage they sit on instead of hand-tuning each number, and the engine, the store framework and the isolation wrapper all read the same shape.
prereq: shared-high-latency-test-fixture
files: packages/quereus/src/vtab/cost-profile.ts (new), packages/quereus/src/vtab/module.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/test/optimizer/high-latency-fixture.ts, packages/quereus/test/vtab/cost-profile.spec.ts (new), packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/src/common/cost-profile.ts, packages/quereus-store/src/common/kv-store.ts, packages/quereus-store/src/common/store-module-base.ts, packages/quereus-store/src/testing/memory-provider.ts, packages/quereus-store/test/expected-latency-plan.spec.ts, docs/optimizer-costing.md, docs/module-capabilities.md, docs/module-authoring.md, docs/optimizer-parallel.md, docs/optimizer-joins.md, docs/runtime-parallel.md, packages/quereus-store/README.md, packages/quereus-isolation/README.md
difficulty: hard
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-11-01T19:11:25.866Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\2-module-cost-profile-and-presets.implement.2026-11-01T19-11-25-866Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

# Module cost profile with named presets

## Why

The planner needs to know, per module, roughly what reading costs. Today a module declares that as two loose optional numbers on `VirtualTableModule` — `expectedLatencyMs` (first row) and `expectedRowLatencyMs` (each further row) — and the store framework resolves two more of its own (`KVStoreProvider.expectedLatencyMs` / `expectedRowLatencyMs`) next to, but outside, its `KVCostProfile`. There is no way to say "this is a file-backed store" or "this is a network service" and get sensible numbers; every author starts from zero and, in practice, declares nothing (see the `NOTE:`s at the LevelDB and IndexedDB providers).

This ticket gives every module **one optional, declarative cost profile** and **named presets** that fill it by storage category. A module that declares nothing plans byte-identically to today. No in-tree module adopts a non-parity preset in this ticket — that is the next link, `store-providers-adopt-cost-presets`, so plan changes on real backends land in a commit of their own.

## Decisions (settled in the plan pass — do not reopen)

**Fields.** The engine profile carries exactly the two latencies, renamed to say what they are:

```ts
/** What reading this module's tables costs, declared by the module. Every field optional; omitted = 0. */
export interface ModuleCostProfile {
	/** Wall-clock milliseconds before a freshly opened iterator hands back its first row. */
	readonly firstRowLatencyMs?: number;
	/** Wall-clock milliseconds per row after the first, in a sequential read (the full-scan rate). */
	readonly perRowLatencyMs?: number;
}
export type ResolvedModuleCostProfile = Required<ModuleCostProfile>;
```

- **`rowsPerRequest` is dropped.** A paging backend's cost is `firstRow + ceil(rows / page) × requestLatency`; the linear model `firstRow + rows × perRow` with `perRow = requestLatency / page` differs from it by at most one request, and plans are sensitive to the order of magnitude only (`docs/optimizer-costing.md` § Units). Document the derivation in `docs/module-authoring.md` so an author who thinks in pages can convert; do not add a ceiling term.
- **The seek and point-read ratios stay store-only.** `KVCostProfile.pointRead` / `seekPositioning` price the store framework's *generic* access planner; the engine has no consumer for them — a custom module prices its own seeks through the `cost` its `getBestAccessPlan` returns, which is already "module currency" that `rule-key-set-seek` probes. Moving them up would be a field with no reader. `backlog/debt-store-seek-positioning-conflates-two-arms` is therefore unaffected by this ticket (a line saying so was appended to it by the plan pass).
- **Concurrency and bandwidth are parked** in `backlog/feat-module-concurrent-requests` and `backlog/feat-module-bandwidth-and-row-size`. Concurrency overlaps the existing `concurrencyMode` capability and needs runtime plumbing (a per-module semaphore) to mean anything; bandwidth has no row-size source to multiply by. Do not ship either field.
- **Counts stay a hook** (`getRowCount`); they change with every write.
- **Units.** Both profile fields are wall-clock milliseconds, converted to engine cost units at `tuning.latencyCostPerMs` by `latencyCost` as today. Preset numbers are *categories*, not measurements — say so in every doc that lists them.
- **The physical-property names do not change.** `PhysicalProperties.expectedLatencyMs` / `expectedRowLatencyMs` are a *subtree's derived estimate* (max of children); the module's *declaration* is the profile. `TableReferenceNode.computePhysical` is the one place the two vocabularies meet and carries a comment saying so. This keeps the six `test/plan/**/*.plan.json` goldens (which serialize `expectedLatencyMs: 0`) and roughly twenty rule sites untouched.
- **Presets are objects a module spreads, not names it looks up.** `readonly costProfile = { ...COST_PRESETS.network, perRowLatencyMs: 0.02 }` is the whole override mechanism — plain object spread merges field by field. No string-keyed registry.
- **Validation** happens twice, with one function: `resolveModuleCostProfile(declared, warn?)` returns a `ResolvedModuleCostProfile`, treating `undefined` as 0, accepting 0 (a valid latency), and replacing a negative or non-finite field with 0 — calling `warn` when given. `SchemaManager.registerModule` calls it with its `warnLog` once per registration (so a bad declaration is reported, once, where the module is named); `TableReferenceNode.computePhysical` calls it without `warn` each plan (cheap: two fields). No NaN ever reaches a cost sum.
- **The 25 ms parallel gates stay as they are.** The gates (`batchedOuterThresholdMs`, `gatherThresholdMs`, `prefetchProbeThresholdMs`) keep reading the subtree's raw `expectedLatencyMs`; presets are chosen so the in-process categories sit below them and the network categories above (table below). Whether the gates should become cost-based for sub-millisecond backends remains `backlog/feat-indexeddb-declares-its-read-latency`'s open decision.
- **Backwards compatibility is not a concern** (AGENTS.md): the old fields are removed, not aliased.

## Presets

```ts
export const COST_PRESETS = Object.freeze({
	/** In-process memory. Identical to declaring nothing. */
	memory:      Object.freeze({ firstRowLatencyMs: 0,    perRowLatencyMs: 0 }),
	/** A file on local disk read in-process through a block cache (LevelDB, SQLite). */
	localDisk:   Object.freeze({ firstRowLatencyMs: 0.05, perRowLatencyMs: 0.004 }),
	/** Browser storage reached across the renderer's IPC boundary (IndexedDB). */
	browserIdb:  Object.freeze({ firstRowLatencyMs: 1,    perRowLatencyMs: 0.01 }),
	/** A service one network round trip away; each request returns a page of rows. */
	network:     Object.freeze({ firstRowLatencyMs: 40,   perRowLatencyMs: 0.04 }),
	/** A distributed store where a request may consult several nodes before answering. */
	distributed: Object.freeze({ firstRowLatencyMs: 100,  perRowLatencyMs: 0.2 }),
} as const satisfies Record<string, ResolvedModuleCostProfile>);
```

Where the numbers come from — record this in `docs/optimizer-costing.md`, with the bands and not more digits than they support:

| preset | first-row source | per-row source | clears the 25 ms gates? |
| --- | --- | --- | --- |
| `memory` | definition | definition | no |
| `localDisk` | LevelDB single-key windowed iterate (open + one read), 0.047–0.069 ms — `packages/quereus-plugin-leveldb/README.md` § Measured read cost | LevelDB sequential iterate, 0.0025–0.0044 ms/row (same table) | no |
| `browserIdb` | IndexedDB one-request arm B: 0.4 ms at 20k rows, 2.0–2.5 ms at 100k — `packages/quereus-plugin-indexeddb/bench/README.md` | IndexedDB full scan arm C: 0.0047–0.011 ms/row | no |
| `network` | no in-repo measurement: one Internet round trip, tens of milliseconds; ~1,000 rows per page | derived: 40 ms / 1,000 rows | yes |
| `distributed` | no in-repo measurement: multi-hop, a request may touch several nodes; ~500 rows per page | derived: 100 ms / 500 rows | yes |

At `latencyCostPerMs = 1000`, `localDisk` prices each row at 4 cost units on top of the engine's 1.0 and each iterator open at 50 — the first time a disk-backed row costs more than a memory row in a join comparison. That is the intended effect, and it lands only when a provider adopts the preset (next ticket).

## Engine changes

- `packages/quereus/src/vtab/cost-profile.ts` (new): `ModuleCostProfile`, `ResolvedModuleCostProfile`, `COST_PRESETS`, `resolveModuleCostProfile`. Export all four from `src/index.ts` next to the other `vtab/module.js` exports.
- `vtab/module.ts`: replace `expectedLatencyMs` / `expectedRowLatencyMs` with `readonly costProfile?: ModuleCostProfile;` carrying the doc comment (hint only, never correctness; presets are categories; spread to override).
- `schema/manager.ts` `registerModule`: resolve with `warnLog` so a bad field warns once naming the module.
- `planner/nodes/reference.ts` `computePhysical`: lift `resolveModuleCostProfile(this.vtabModule.costProfile)` — `firstRowLatencyMs` into `out.expectedLatencyMs` and `perRowLatencyMs` into `out.expectedRowLatencyMs`, each only when `> 0` (unchanged rule, so leaves still omit the key at 0 and the goldens stay byte-identical).
- Comment-only updates where the old field names are quoted as *module* declarations: `plan-node.ts` (the two property docs), `cost/index.ts` (`latencyCost` doc, `indexNestedLoopJoinCost` NOTE), `optimizer-tuning.ts` (`latencyCostPerMs` doc; the `parallel` docs may keep saying `expectedLatencyMs` where they mean the subtree property), `rule-join-physical-selection.ts` (`readMs` doc), `index-nested-loop.ts`, `rule-fanout-batched-outer.ts` (its NOTE about a module declaring per-row only), `rule-nested-loop-right-cache.ts` NOTE. Grep `expectedLatencyMs\b` and `expectedRowLatencyMs\b` across `src` and decide per hit: subtree property (keep) or module declaration (rename to the profile field).

## Isolation wrapper

Replace the two getters in `IsolationModule` with one live getter `get costProfile(): ModuleCostProfile` that returns the underlying's profile, or an empty object when it declares none (a getter returning a concrete object satisfies the optional `costProfile?` under `exactOptionalPropertyTypes`, the same reason the old getters returned `0` rather than `undefined`). Nested wrappers forward by recursion. The overlay module contributes nothing (in-memory staging). Update the `modeStub` in `isolation-layer.spec.ts` (around line 4697) and the forwarding assertions there, and the "Transparent hook forwarding" paragraph in `packages/quereus-isolation/README.md`.

## Store framework

- `KVCostProfile extends ModuleCostProfile` and keeps `pointRead` / `seekPositioning`; `ResolvedCostProfile = Required<KVCostProfile>`. `resolveCostProfile` resolves the two ratios as today (parity default, warn on bad) and the two latencies through the engine's `resolveModuleCostProfile` with the same `console.warn` sink. Delete `LatencyField` and `resolveExpectedLatencyMs`.
- `KVStoreProvider`: delete `expectedLatencyMs` / `expectedRowLatencyMs`; fold their doc comments into `costProfile`'s ("declare a preset for the category of backend you are, override with measured numbers where you have them, never invent a precise number").
- `StoreModuleBase`: the `protected costProfile: ResolvedCostProfile` becomes **public** `readonly costProfile: ResolvedCostProfile` — a superset of `ModuleCostProfile`, so it satisfies `VirtualTableModule.costProfile` directly. Delete the two public latency fields. Nothing else in the store reads them (grep to confirm).
- `testing/memory-provider.ts`: unchanged in shape (`options.costProfile` already forwards verbatim); update its comments.
- `test/expected-latency-plan.spec.ts`: the provider declares `costProfile: { firstRowLatencyMs: HIGH_LATENCY_MS }`; assertions read `new StoreModule(p).costProfile.firstRowLatencyMs`. Drop its unusable-value cases — they move to the engine resolver's test below — but keep the plan-level assertion that the declared latency reaches the planner through `StoreModule`, which is the thing that spec exists to prove.

## Tests

- **One new test** `packages/quereus/test/vtab/cost-profile.spec.ts` for `resolveModuleCostProfile`: a negative, a `NaN` and an `Infinity` field each resolve to 0 and call `warn` once naming the field; `0` is accepted silently; an undeclared profile resolves to zeros without warning; `COST_PRESETS.memory` resolves equal to declaring nothing. This replaces the store spec's unusable-value cases at the layer that now owns the rule.
- The shared fixture from the previous ticket changes to `readonly costProfile = { firstRowLatencyMs: HIGH_LATENCY_MS }` and `{ firstRowLatencyMs: HIGH_LATENCY_MS, perRowLatencyMs: 1 }`. No spec assertion changes.
- No test for preset spreading (object spread is the language), none for the registration call (wiring), none for the isolation getter (a one-line forward; the existing isolation forwarding test covers presence).

## Docs

Edit alongside the code (`yarn docs:check` must pass):

- `docs/optimizer-costing.md` § "First-row latency in cost comparisons" → retitle "Module cost profile": the shape, the preset table with sources above, the units paragraph (unchanged substance), the drains paragraph (unchanged), and a sentence that the physical-property names are the subtree estimate while the profile is the declaration.
- `docs/module-capabilities.md` surface inventory: replace the `expectedLatencyMs` and `expectedRowLatencyMs` rows with one `costProfile` row (static field; fallback = zeros; memory: none; store: provider-declared, latencies resolved by the engine rule and ratios by the store's; isolation: forwards underlying; plugins: "none until `store-providers-adopt-cost-presets`").
- `docs/module-authoring.md`: a short "Declaring a cost profile" section — pick a preset, spread to override, the page-to-per-row derivation, and that a hint never affects correctness.
- `docs/optimizer-parallel.md`: one paragraph stating which presets clear the 25 ms gates (table above, condensed).
- `docs/optimizer-joins.md` § Storage latency (around line 183) and `docs/runtime-parallel.md` (around line 84): rename the module-declaration mentions; subtree-property mentions stay.
- `packages/quereus-store/README.md`: merge the three "Backend cost profile / first-row latency / per-row latency" paragraphs (lines ~101–165) into one "Backend cost profile" section with the unified shape and a pointer to the presets; the ratio discussion stays as is.

## Edge cases & interactions

- **A module declaring nothing plans byte-identically to today.** Verified by the full `yarn test` (the `test/plan` goldens serialize `expectedLatencyMs: 0` and must not change) and `yarn bench:gate` work counters unchanged.
- **A preset plus partial overrides merges field by field** — by construction of object spread; verified by inspection. A preset object is frozen, so a module that mutates `COST_PRESETS.network.firstRowLatencyMs` throws in strict mode rather than editing every other module's preset.
- **Isolation forwards the profile of the module it wraps; nested wrappers too** — by the recursive getter; the existing isolation forwarding test covers one level.
- **Invalid values** (negative, NaN, Infinity) resolve to 0 with one warning at registration and silently at the leaf; `0` is valid; verified by the new resolver test.
- **Store: a provider that still spells `expectedLatencyMs` on itself** after this ticket is a type error at the provider when declared in an object literal (`KVStoreProvider` no longer has the property), but a class field is not caught; acceptable — no in-tree provider declares one, and the next ticket touches all four.
- **Parallel rules and the 25 ms gates under each preset**: the fixture still declares exactly the gate value, so every parallel spec keeps exercising the `>=` side of its gate; the preset table documents which categories cross.
- **Cardinality-feedback re-plan paths are unaffected** — the profile is static per module and the leaf lift is the same code path feedback already re-runs.
- **`StoreModuleBase.costProfile` going public** exposes the resolved ratios to callers that previously could not see them; nothing in-tree reads them that way, and the field is `readonly` and the parity object is frozen.
- **QuickPick tour scoring** still reads `getTotalCost()` with no latency (its NOTE stays); presets do not change that.

## Notes for the runner

Run `yarn test` and `yarn lint` from the repo root in the foreground; `yarn test:store` is the next ticket's concern (no provider adopts a preset here, so store plans are unchanged). Benchmarks under ~5 minutes in the foreground only.

## TODO

- [ ] Phase 1 — engine: `vtab/cost-profile.ts` (type, presets, resolver), `module.ts` field swap, `index.ts` exports, `schema/manager.ts` registration warning, `reference.ts` leaf lift, comment sweep over the rule sites listed above
- [ ] Phase 1 — tests: resolver spec; shared fixture declares `costProfile`; `yarn workspace @quereus/quereus test` green with goldens unchanged
- [ ] Phase 2 — isolation: `costProfile` getter replaces the two latency getters; `isolation-layer.spec.ts` stub and assertions; README paragraph
- [ ] Phase 2 — store: `KVCostProfile extends ModuleCostProfile`, provider fields removed, `StoreModuleBase.costProfile` public, `resolveExpectedLatencyMs` deleted, `expected-latency-plan.spec.ts` rewritten, memory-provider comments
- [ ] Phase 3 — docs listed above; `yarn docs:check`
- [ ] `yarn build && yarn lint && yarn typecheck && yarn test && yarn bench:gate` from the repo root
