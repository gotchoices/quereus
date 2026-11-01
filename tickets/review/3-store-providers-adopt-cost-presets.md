description: The in-tree storage backends now tell the query planner what category of storage they are — local disk for LevelDB and the two mobile backends, browser storage for IndexedDB — so the planner stops pricing a file or browser store as if it were in-process memory; review the declarations, the rewritten decision comments, and the doc sweep.
prereq: module-cost-profile-and-presets
files: packages/quereus-plugin-leveldb/src/provider.ts, packages/quereus-plugin-leveldb/README.md, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus-plugin-react-native-leveldb/src/provider.ts, packages/quereus-plugin-nativescript-sqlite/src/provider.ts, packages/quereus-store/README.md, packages/quereus-store/src/common/cost-profile.ts, packages/quereus-store/test/expected-latency-plan.spec.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/test/optimizer/high-latency-fixture.ts, packages/quereus/test/optimizer/join-latency-cost.spec.ts, packages/quereus/bench/suites/store.bench.mjs, docs/module-capabilities.md, docs/optimizer-costing.md, docs/optimizer-joins.md, docs/progressive-optimizer.md, tickets/backlog/feat-indexeddb-declares-its-read-latency.md
----

# In-tree providers adopt a cost preset — review handoff

## What changed

Each in-tree `KVStoreProvider` now declares a `costProfile` built from the engine's `COST_PRESETS` (from `@quereus/quereus`, already a peer and dev dependency of every plugin):

| provider | declaration |
| --- | --- |
| `LevelDBProvider` | `COST_PRESETS.localDisk` (no ratios; parity `pointRead` / `seekPositioning` stay) |
| `IndexedDBProvider` | `{ ...COST_PRESETS.browserIdb, pointRead: 3.0, seekPositioning: 5.0 }` |
| `ReactNativeLevelDBProvider` | `COST_PRESETS.localDisk` |
| `SQLiteProvider` (NativeScript) | `COST_PRESETS.localDisk` |

LevelDB and the two mobile providers assign the frozen preset object itself. That's safe: `resolveCostProfile` spreads it into a fresh object, and a mutation would throw.

The decision comments were rewritten:
- **LevelDB:** the ratio `NOTE:` keeps its substance; only its opening line changes, from "no costProfile" to "no ratios". The latency `NOTE:` now says the latency half is the `localDisk` category and its bands come from the README table. It also says the preset buys join selection, not parallelism, and that it can be revisited only with a purpose-taken multi-run measurement.
- **IndexedDB:** the latency `NOTE:` says the latency half is the `browserIdb` category, grounded in bench arms B and C. It states that the 25 ms gates stay inert, and that two items remain open in `feat-indexeddb-declares-its-read-latency`.
- **Mobile providers:** one short `NOTE:` each.

## Doc and comment sweep (beyond the ticket's list)

Any sentence claiming "no in-tree provider/module declares a latency" became false. These were all updated:
- store README § Backend cost profile: table column plus paragraph.
- `docs/module-capabilities.md`: the `costProfile` row.
- `docs/optimizer-costing.md` § Module cost profile: two sentences.
- `docs/optimizer-joins.md` § Storage latency: one sentence.
- `docs/progressive-optimizer.md` § 5: the IndexedDB bullet.
- LevelDB README: section heading, sub-heading and opening sentence. The heading anchor `#measured-read-cost-and-why-no-cost-profile-is-declared` changed, and grep found no links to it.
- `quereus-store/src/common/cost-profile.ts`: one clause.
- `store.bench.mjs`: header comment.
- `rule-quickpick-enumeration.ts`: the `NOTE:` justification.
- `rule-fanout-lookup-join.ts`: two comments.
- Two test-file header comments.

**Reviewer: check the fan-out reasoning in `rule-fanout-lookup-join.ts`.** The old comment said "latency is 0 on local chains, so the rule is inert". That is no longer true for store tables: `localDisk` and `browserIdb` pass the `maxLatency === 0` skip. The rule still never fires, because the gate `(N − cap) × L > N × branchSetupCost` can't pass while `L ≤ branchSetupCost` (1 ms). `browserIdb` sits exactly at 1 ms, and the comparison stays false because `cap ≥ 1`. A host that lowers `tuning.branchSetupCost` below 1 ms could make fan-out fire on IndexedDB. That is a host tuning choice, not a defect, but worth a glance.

The backlog ticket `feat-indexeddb-declares-its-read-latency` was trimmed:
- Description, tradeoffs and intro now describe the category as declared.
- "What to do" now reads "re-measure, then override only if outside the category".
- The applied scope-note section was removed.
- The 25 ms gates section is unchanged.

## Validation

- `yarn build`, `yarn typecheck` and `yarn docs:check` are clean.
- `yarn test`: all green. Engine suite 10864 passing; every workspace suite passed, including the IndexedDB vitest suites on `fake-indexeddb`.
- `yarn test:store`: 10856 passing, 33 pending, 0 failing. No planner defects surfaced at `localDisk` prices, and no spec needed an expectation change.
- Probe: a `StoreModule` over `LevelDBProvider` resolves to `{ firstRowLatencyMs: 0.05, perRowLatencyMs: 0.004, pointRead: 1, seekPositioning: 0.5 }`.
- Logs: `tickets/.logs/store-providers-adopt-cost-presets.test.log` and `.test-store.log`.

## Tests added

None. The change is four field declarations, which is wiring. Resolution and forwarding of a provider's profile are already pinned by `quereus-store/test/cost-profile.spec.ts`, `expected-latency-plan.spec.ts` and the isolation forwarding specs. Asserting that a preset is declared would only test a constant.

## Known gaps / what a reviewer might probe

- **This pass did not check whether plans changed.** `test:store` asserts results, not plan shape. That plans shift on LevelDB (join selection and right-cache pricing at about 5 units per disk row) is the intended effect, but no test observes it on a real backend. If the reviewer wants evidence, the place to look is `explain` on a two-table join under the LevelDB store, comparing index-nested-loop and hash selection before and after.
- **The React Native and NativeScript providers are compile-checked only.** Their vitest suites pass, but neither runs on a device here. The new runtime import from `@quereus/quereus` matches what the other plugins already do.
- **No benchmark gates were re-run.** `yarn bench:gate` is memory-backed and unaffected, and the opt-in LevelDB bench rows are informational.
