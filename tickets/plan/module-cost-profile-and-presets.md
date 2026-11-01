description: Give every module one optional, declarative cost profile (latency, rows per request, relative seek/point-read cost, concurrency, and possibly bandwidth) with named presets such as local-disk and distributed, so a file-backed module and a network-backed module plan differently without hand-tuning each number.
difficulty: hard
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus-store/src/common/cost-profile.ts, packages/quereus-store/src/common/kv-store.ts, packages/quereus-store/src/common/store-module-base.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus-plugin-leveldb/src/provider.ts, docs/module-capabilities.md, docs/module-authoring.md, docs/optimizer-costing.md, docs/optimizer-parallel.md, docs/progressive-optimizer.md, packages/quereus-store/README.md, packages/quereus-isolation/README.md
----

# Module cost profile with named presets

## Motivation

Quereus targets storage ranging from in-process memory to a distributed hash table across a network (see `docs/progressive-optimizer.md`). The planner needs to know, per module, roughly what reading costs. Today that knowledge is split and partial:

- **Engine, any module** (`vtab/module.ts`): two loose optional numbers, `expectedLatencyMs` (first row) and `expectedRowLatencyMs` (each further row), converted to cost units by `OptimizerTuning.latencyCostPerMs` (`planner/cost/index.ts`). Plus the dynamic `getRowCount(db, table)` hook returning `{ rows, exact }`.
- **Store package only** (`quereus-store/src/common/cost-profile.ts`): `KVCostProfile` with `pointRead` and `seekPositioning`, ratios relative to one sequentially scanned row, and the provider-declared latencies resolved through `resolveExpectedLatencyMs`. A custom (non-store) module cannot declare relative seek or point-read cost at all.
- **Nowhere:** how many rows one round trip returns (a network page), whether requests can run concurrently, or throughput (bytes per second). A distributed module's cost comes in steps — one per page fetched — which per-row latency can only approximate.

The human's request (2026-11-01): "have hooks for counts/latency/bandwidth that modules can optionally implement," and "some kind of default profile so that a file storage module can default differently than a distributed network module."

## Proposed direction (to be settled by this plan pass)

1. **One engine-level `ModuleCostProfile`**, declared on the module (static, like today's latency fields), every field optional. Candidate fields: `firstRowLatencyMs`, `perRowLatencyMs` (the existing two, renamed or kept), `rowsPerRequest` (round-trip page size), `pointRead` and `seekCost` (ratios, moved up from `KVCostProfile` so every module can declare them), `concurrentRequests` (fetches in flight at once; affects batched lookups and the parallel rules), and `bytesPerSecond` (see 4).
2. **Named presets**, exported from the engine: e.g. `memory`, `local-disk`, `browser-idb`, `network`, `distributed`. A module declares a preset name, or spreads a preset and overrides fields. A module that declares nothing gets the profile that reproduces today's plans exactly (`memory` / parity) — no plan changes until a module opts in.
3. **Store integration**: `KVCostProfile` becomes the engine profile plus store-only knobs (or is retired into it); providers (`indexeddb`, `leveldb`, test memory provider) declare a preset; `IsolationModule` forwards the profile as it forwards `expectedLatencyMs` today.
4. **Bandwidth needs a row-size source** — the cost model has no notion of bytes per row. Decide: (a) add an optional average row size to `getRowCount`'s answer (`ModuleRowCount`), (b) estimate from declared column types, or (c) leave `bytesPerSecond` out of this pass and park it. Do not ship a bandwidth field that has no row size to multiply by.
5. **Counts stay a hook** (`getRowCount`), not a profile field — they change with every write.

## Questions to resolve before emitting implement tickets

- **Ratios vs milliseconds.** The store chose ratios deliberately (a wall-clock number is right only on the device it was measured on — see the doc comment in `cost-profile.ts`). Presets will pair ratios with order-of-magnitude latencies; document that preset numbers are categories, not measurements. Decide which fields are ratios and which are milliseconds.
- **How `rowsPerRequest` enters cost.** Likely `firstRowLatency + ceil(rows / rowsPerRequest) × requestLatency` in place of `rows × perRowLatency`; check every consumer of `expectedRowLatencyMs` (join physical selection, QuickPick, index nested loop, fanout lookup/batched outer, nested-loop right cache) uses one shared function in `planner/cost/index.ts`, not a restated formula.
- **Interaction with the 25 ms parallel gates** in `optimizer-tuning.ts` (async gather, eager prefetch, fanout) — do presets move plans across those gates, and should `concurrentRequests` replace or inform them?
- **Preset values.** Ground `local-disk` in the LevelDB measurements (`packages/quereus-plugin-leveldb/README.md` § Measured read cost) and `browser-idb` in the IndexedDB benchmark evidence (`backlog/feat-indexeddb-declares-its-read-latency`). `network` / `distributed` have no in-repo measurement: choose defensible orders of magnitude and say so.
- **Field naming / migration.** Backwards compatibility is not a concern yet (AGENTS.md); prefer one clean shape over aliases.

## Related tickets (fold in or reference; don't duplicate)

- `backlog/feat-indexeddb-declares-its-read-latency` — IndexedDB would declare the `browser-idb` preset; may be absorbed.
- `backlog/debt-store-seek-positioning-conflates-two-arms` — splitting `seekPositioning` per arm; decide whether the new profile shape settles it.
- `backlog/debt-leveldb-cost-profile-measurement`, `backlog/debt-shared-high-latency-test-module` — measurement and a shared slow test module are natural companions.
- Parked follow-on: `backlog/feat-observed-module-latency-feedback` (measure latency at run time to correct a wrong preset).

## Edge cases & interactions (for the implement tickets to carry)

- A module declaring nothing plans byte-identically to today (verify: full `yarn test`, `yarn bench:gate` work counters unchanged).
- A preset plus partial overrides merges field by field.
- Isolation wrapper forwards the profile of the module it wraps; nested wrappers too.
- Invalid values (negative, NaN, zero `rowsPerRequest`) are rejected or ignored with a logged warning at registration, never silently producing NaN costs.
- Parallel rules and their 25 ms gates under each preset.
- The cardinality-feedback re-plan paths are unaffected (profile is static per module).

## Notes for the runner

Benchmarks must run in the background or stay under ~5 minutes in the foreground; runner agents are killed after 10 minutes of idle output. Do not run interleaved A/B worktree benchmarks.

## TODO

- [ ] Resolve the questions above; record decisions and tradeoffs in `docs/module-capabilities.md` / `docs/optimizer-costing.md`
- [ ] Emit `prereq:`-chained implement tickets, each sized to one agent run (likely: engine profile type + presets + cost function; migrate engine consumers; store/isolation/provider integration; bandwidth + row size if kept)
- [ ] Park anything out of scope in `backlog/` with a `feat-`/`debt-` prefix
