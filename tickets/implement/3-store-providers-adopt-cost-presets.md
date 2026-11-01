description: Make the in-tree storage backends tell the query planner what category of storage they are (local disk for LevelDB and the two mobile backends, browser storage for IndexedDB) by adopting the new cost presets, so the planner stops treating a file or browser store as if it were in-process memory, and confirm the store test suite still passes under the changed plans.
prereq: module-cost-profile-and-presets
files: packages/quereus-plugin-leveldb/src/provider.ts, packages/quereus-plugin-leveldb/README.md, packages/quereus-plugin-indexeddb/src/provider.ts, packages/quereus-plugin-react-native-leveldb/src/provider.ts, packages/quereus-plugin-nativescript-sqlite/src/provider.ts, packages/quereus-store/README.md, docs/module-capabilities.md, docs/progressive-optimizer.md, docs/optimizer-costing.md, tickets/backlog/feat-indexeddb-declares-its-read-latency.md
difficulty: medium
----

# In-tree providers adopt a cost preset

The previous ticket (`module-cost-profile-and-presets`) gave every module a `costProfile` and shipped `COST_PRESETS` (`memory`, `localDisk`, `browserIdb`, `network`, `distributed`), exported from `@quereus/quereus`, with every in-tree module still declaring nothing. This ticket is the opt-in, kept separate so the first plan changes on real backends land in a commit of their own and `yarn test:store` is the gate.

## Why declaring a category is now the right call

Both plugin providers carry a `NOTE:` explaining why they declare no latency: "declare only measured numbers", and the 25 ms gates mean an honest sub-millisecond number would turn no parallel machinery on. The first objection is answered by presets being *categories* with their sources recorded in `docs/optimizer-costing.md` (LevelDB's bands from its README § Measured read cost; IndexedDB's from its bench README) — a category is an honest claim where a decimal would not be. The second was never an argument against declaring: the value of the per-row figure is in **join selection**, where a disk-backed row now costs about 5 engine units instead of 1, not in the parallel gates, which the in-process presets deliberately stay below.

## What to change

- **LevelDB** (`quereus-plugin-leveldb/src/provider.ts`): `readonly costProfile: KVCostProfile = COST_PRESETS.localDisk;` (import from `@quereus/quereus`, a declared dependency). The ratio half (`pointRead` / `seekPositioning`) stays **undeclared** — the reasons in the existing `NOTE:` (the two-arm conflation, `backlog/debt-store-seek-positioning-conflates-two-arms`) are unchanged. Rewrite the two `NOTE:` blocks above the class: keep the ratio decision verbatim in substance; replace the "no latency declared" paragraph with: the latency half is the `localDisk` category, whose bands come from this README's own table, and the decimals still live in the README, not here.
- **LevelDB README** § Measured read cost: the opening paragraph says "LevelDB declares nothing" — now it declares the `localDisk` latency category and still no ratios; one sentence, keep the tables.
- **IndexedDB** (`quereus-plugin-indexeddb/src/provider.ts`): `readonly costProfile: KVCostProfile = { ...COST_PRESETS.browserIdb, pointRead: 3.0, seekPositioning: 5.0 };`. Rewrite the `NOTE:` under it: the measured ratios stay; the latency half is the `browserIdb` category grounded in `bench/README.md`'s arms B and C; the two open items that remain are a real-browser re-measurement of first-row and per-row (the bench arms were built to derive ratios) and the gates decision — both still `backlog/feat-indexeddb-declares-its-read-latency`.
- **React Native LevelDB** and **NativeScript SQLite** providers: `COST_PRESETS.localDisk`, one short comment each (unmeasured in-process backends; the category is the honest claim, a measured override is welcome).
- **Store README**: the "no in-tree provider declares one" sentences in the cost-profile section → which preset each provider declares.
- **`docs/module-capabilities.md`** `costProfile` row, plugins column: `localDisk` / `browserIdb` with measured ratio overrides on IndexedDB.
- **`docs/progressive-optimizer.md`** § 5 Deferred work: the IndexedDB bullet narrows to "real-browser re-measurement and the gates decision".
- **`tickets/backlog/feat-indexeddb-declares-its-read-latency.md`**: the plan pass already re-pointed its `prereq:` here and added a scope note; after this lands, trim its "What to do" to the two remaining items if anything in it now reads as done.

## Edge cases & interactions

- **`yarn test:store` must pass** (LevelDB-backed logic tests). Latency changes only join selection, index-nested-loop versus hash choice, and the nested-loop right-cache pricing — never results — so a failure here is a planner defect surfaced by the new prices, not a test to adjust. Run it in the foreground; it is the slow suite (several minutes), stream it with `| tee tickets/.logs/store-providers-adopt-cost-presets.test-store.log`.
- **Store-package and plugin specs that assert plan shape** (grep `explain\|plan` under `packages/quereus-store/test` and `packages/quereus-plugin-indexeddb/test`): the memory test provider (`createInMemoryProvider`) declares no preset and stays at parity, so store-package specs are unaffected unless they wrap a plugin provider. IndexedDB specs run on `fake-indexeddb`; any plan assertion there now sees `browserIdb` prices — expected, update the expectation only after confirming the new plan is the better one at those prices.
- **The 25 ms gates stay inert** for `localDisk` (0.05 ms) and `browserIdb` (1 ms): no batched seek, gather or prefetch fires on any in-tree backend after this ticket — verified by inspection of the preset table; state it in the IndexedDB `NOTE:`.
- **Isolation over LevelDB** (the shape `yarn test:store` runs): the wrapper forwards the profile, so the isolated store plans at `localDisk` prices too — intended; nothing to do unless a test fails.
- **`latencyCostPerMs` interaction**: at the default 1000, `localDisk` per-row = 4 units/row. A host that tunes `latencyCostPerMs` for different hardware scales the preset's effect with it — that is the design; no per-preset knob.
- **No benchmark gate changes**: `yarn bench:gate` runs memory-backed; its work counters stay unchanged. The opt-in LevelDB store bench rows are informational and not re-run here.

## TODO

- [ ] LevelDB provider: adopt `localDisk`; rewrite both `NOTE:` blocks; README sentence
- [ ] IndexedDB provider: spread `browserIdb` with the measured ratios; rewrite the `NOTE:`
- [ ] React Native LevelDB and NativeScript SQLite providers: adopt `localDisk`
- [ ] Docs: store README, module-capabilities row, progressive-optimizer deferred bullet; `yarn docs:check`
- [ ] `yarn build && yarn typecheck && yarn test` then `yarn test:store` in the foreground with `tee` into `tickets/.logs/`
- [ ] Trim `backlog/feat-indexeddb-declares-its-read-latency.md` to what remains open
