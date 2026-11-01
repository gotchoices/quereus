description: The in-tree storage backends now tell the query planner what category of storage they are — local disk for LevelDB and the two mobile backends, browser storage for IndexedDB — so the planner stops pricing a file or browser store as if it were in-process memory.
prereq: module-cost-profile-and-presets
files: packages/quereus-plugin-leveldb/src/provider.ts, packages/quereus-plugin-leveldb/README.md, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus-plugin-react-native-leveldb/src/provider.ts, packages/quereus-plugin-nativescript-sqlite/src/provider.ts, packages/quereus-store/README.md, packages/quereus-store/src/common/cost-profile.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/nodes/reference.ts, docs/module-capabilities.md, docs/optimizer-costing.md, docs/optimizer-joins.md, docs/optimizer-parallel.md, docs/progressive-optimizer.md
----

# In-tree providers adopt a cost preset — complete

## What landed

Each in-tree `KVStoreProvider` declares a `costProfile` built from the engine's `COST_PRESETS`:

| provider | declaration |
| --- | --- |
| `LevelDBProvider` | `COST_PRESETS.localDisk` (no ratios; parity `pointRead` / `seekPositioning` stay) |
| `IndexedDBProvider` | `{ ...COST_PRESETS.browserIdb, pointRead: 3.0, seekPositioning: 5.0 }` |
| `ReactNativeLevelDBProvider` | `COST_PRESETS.localDisk` |
| `SQLiteProvider` (NativeScript) | `COST_PRESETS.localDisk` |

The decision `NOTE:` comments at the LevelDB and IndexedDB providers were rewritten: each latency half is a category, not a measurement for this declaration; it moves join selection only; none of the 25 ms parallel gates fire. The mobile providers carry one short `NOTE:` each. Docs and comments that claimed "no in-tree module declares a latency" were swept (store README, LevelDB README, `module-capabilities.md`, `optimizer-costing.md`, `optimizer-joins.md`, `progressive-optimizer.md`, bench header, planner rule comments, test headers). `backlog/feat-indexeddb-declares-its-read-latency` was trimmed to what remains open: a real-browser re-measurement, and whether the 25 ms gates should become cost-based. Implement commit: `ticket(implement): store-providers-adopt-cost-presets`.

## Review findings

**Diff read first, then handoff.** Checked the four declarations, the rewritten `NOTE:`s, the doc sweep, the fan-out reasoning the handoff flagged, and searched for stale claims the sweep missed.

- **Correctness of declarations** — fine. LevelDB and the mobile providers assign the frozen preset directly. That is safe because the store's resolver copies it (`resolveCostProfile`), and the engine registry resolves into a fresh object. IndexedDB spreads the preset, then overrides with its measured ratios. The type is `KVCostProfile`, which extends `ModuleCostProfile`. Runtime import of `COST_PRESETS` from `@quereus/quereus` matches what each plugin already imports.
- **Fan-out reasoning (`rule-fanout-lookup-join.ts`)** — verified against the code at the cost gate. Savings are `(N − cap) × L` with `cap ≥ 1`. Overhead is `N × branchSetupCost` (default 1.0 ms). Savings can't exceed overhead while `L ≤ 1`, so the rule stays inert for both presets, including `browserIdb` at exactly 1 ms. A host that lowers `tuning.branchSetupCost` below 1 ms could make it fire on IndexedDB. The header comment already states the `L ≤ branchSetupCost` condition, and this is a host tuning choice rather than a defect, so no further note was added.
- **Plan effect (the handoff's main open gap)** — I probed it directly with a throwaway script, now deleted. It ran `query_plan` on a LevelDB store with 300 / 2000 / 100-row tables, once with the preset and once with `costProfile` forced off. Result: an indexed `a join b on b.aid = a.id` flips from index-nested-loop (300 seeks into `b_aid`) to a hash join over both scans. The other three joins I tried (a non-indexed equi join, a primary-key lookup join with a filter, a three-way join) were identical apart from attribute numbering. The flip is the intended effect, and it agrees with the LevelDB README's measurement: a windowed seek costs about 12–15 sequential rows, so 300 seeks cost more than scanning 2300 rows. No test pins this, and none was added: plan shape on a real backend is a heuristic outcome and would be a brittle golden.
- **Stale claims the sweep missed** (minor, fixed inline). After this change several comments said in-process leaves report 0 latency, which is no longer true for store tables:
  - `rule-join-physical-selection.ts`: `readMs` doc, plus two "every in-tree module reports 0" hot-path claims.
  - `rule-async-gather-union-all.ts`: header and gate comment.
  - `rule-async-gather-zip-by-key.ts`: header.
  - `rule-eager-prefetch-probe.ts`: header and gate comment.
  - `planner/nodes/reference.ts`: leaf-lift comment.
  - `docs/optimizer-parallel.md` § batched outer: "inert … (`expectedLatencyMs = 0`)".

  Each now says that memory reports 0 and that the in-process store presets sit far below the 25 ms thresholds. I also corrected the IndexedDB `costProfile` JSDoc, which still described the whole profile as "a ratio and not milliseconds". It now names itself as the ratio half and points to the latency `NOTE:`.
- **Tripwire parked** — `rule-join-physical-selection.ts` (batched index-nested-loop candidate): store tables now pass the zero-latency skip. So each at-most-one index-nested-loop candidate builds a serial `FanOutLookupJoinNode`, only for `toBatchedOuter`'s 25 ms gate to decline it. This is cheap per candidate. A `NOTE:` at the skip says to short-circuit on the gate's own threshold if it ever shows in planning profiles.
- **Tests** — the implementer added none, and that is correct: four field declarations are wiring, and preset resolution and forwarding are already pinned by `quereus-store/test/cost-profile.spec.ts` and the forwarding specs. Nothing to cut; I added nothing.
- **Mobile providers** — compile-checked and unit-tested only. They were not run on a device; that wasn't available here and the change is a constant field.
- **Error handling, resource cleanup, performance, DRY, file size** — nothing to report. The change adds no control flow, allocates nothing per query, and repeats no logic. Each provider's preset choice is a one-line declaration.
- **Docs** — every file in the implement diff was read. The additional docs the change should have touched are the ones listed above, now fixed. `yarn docs:check` passes.

**Validation:** `yarn workspace @quereus/quereus run lint` clean. `yarn test` all green (engine 10864 passing; every workspace suite passed). `yarn docs:check` OK. Log: `tickets/.logs/store-providers-adopt-cost-presets.review.test.log`. `yarn test:store` was not re-run: review edits are comment-only, and the implement pass ran it green (10856 passing).
