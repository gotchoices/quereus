description: The query planner now asks a storage backend for the row count it already keeps while planning, so a never-analyzed table is sized honestly for join choice and every other cost decision, not only for its own scan. Review the implementation, a planner bug it exposed and fixed, and the behaviour changes it causes on purpose.
architecture: docs/progressive-optimizer.md#33-precedence-one-row-count-per-plan
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/rules/access/rule-key-set-seek.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus/test/optimizer/index-seek-row-estimates.spec.ts, packages/quereus-store/test/live-row-count-plans.spec.ts, packages/quereus/bench/reference/execution.json, docs/progressive-optimizer.md, docs/optimizer-costing.md, docs/module-capabilities.md, docs/module-authoring.md, docs/store.md, docs/invariants.md, packages/quereus-isolation/README.md
difficulty: medium
----

# The planner asks the module how big a table is — review handoff

## What was built

- **Hook.** New optional `VirtualTableModule.getRowCount?(db, table): ModuleRowCount | undefined` with `ModuleRowCount { rows, exact }` (`vtab/module.ts`, exported from the package root). Its doc comment carries the contract: answer from memory in constant time or decline, never start I/O; `rows` is what a read issued now would see; `exact` only for a count kept up to date on every write; only a hint.
- **Seam.** `plannedRowCount(table, sources)` (`planner/stats/table-cardinality.ts`) now ranks: exact module count → overlay's observed count → approximate module count → catalog (`ANALYZE`) count → `undefined`. `RowCountSources` (`observedRows` + `reportedRows`) is built once per `Database` by `databaseRowCountSources`, injected into `CatalogStatsProvider`, and exposed by `SchemaManager.getRowCountSources()` (replaces `getObservedRowCounts`). The module is asked first. `reportedRowCount` looks the module up with `schemaManager.getModule(table.vtabModuleName)`; a throw or a malformed answer (not a non-negative integer) is debug-logged and treated as "no answer".
- **Overlay baseline.** `CardinalityFeedbackManager.record` computes `before` through `plannedRowCount` (its own entry + the module count via a new context field `reportedRows`), so a full scan of an exactly sized table compares against the module count.
- **Modules.** `StoreModule.getRowCount` returns `getKnownRowCount()` as exact, or nothing while no count is in memory. `IsolationModule` forwards it only when the underlying module has it (assigned in the constructor, like `getBackingHost`). Memory backend unchanged (`feat-memory-backend-sizes-itself` should implement the hook).
- **`sizeRequestFromLiveCount`**'s doc now calls it a backstop. A real query no longer reaches its substitution: the planner already sends the live count, and when the hook has no answer there is no live count to fill in.

## Bug found and fixed along the way (please scrutinize)

`yarn test:store` failed `41.3-alter-rename-propagation.sqllogic` (`refresh materialized view qmv_c67`: "primary-key column count 1 → 0"). Withholding the hook made it pass, so this change exposed it. The cause was older: `IndexSeekNode.computePhysical` stamped the "at most one row in the whole result" dependency (`∅ → all columns`) on any full-primary-key equality seek, including a **correlated** seek — the inner side of a nested-loop join, keyed on the outer row. Above the join that claim shrank the join's key to the empty key. Reproduced on the **memory backend with no module counts** (an `analyze`d tiny inner table, which makes the planner choose nested loop + seek): `create materialized view` over such a join with two matching rows was wrongly rejected with "body produces duplicate rows". Store tables now get that plan shape without `analyze`, which is why the test surfaced it.

Fix (`table-access-nodes.ts`): a full-primary-key seek whose keys reference any column (correlated) keeps `estimatedRows: 1` but no longer stamps the dependency. Literal and parameter keys are unchanged. The stale "nothing leans on that FD today" comment is corrected: materialized-view key derivation (`keysOf`) leans on it. Reviewer: check that nothing relied on the false claim. The full suites pass, but a rewrite that wanted "inner side is at most one row per outer row" may now quietly decline.

## Behaviour that changes on purpose (release notes)

- An exact store count outranks a stale `ANALYZE` snapshot (pinned: 139, not 137).
- Never-analyzed store joins now plan like analyzed ones. Measured in the new test: 20,000-row `big`, 300-row `mid` → nested loop + primary-key seek, no hash join (with the hook withheld: hash join).
- **Materialized views:** a body that can only be fully rebuilt (no incremental maintenance), over a never-analyzed store table holding more than `materialized_view_rebuild_row_threshold` (10,000) rows, is now rejected at `create`. That check used to see the 1,000-row default.
- `cardinality_feedback = false` does not turn off module counts (documented in progressive-optimizer §3.7).
- **Stale prepared plans:** a cached statement keeps the count it compiled with. Once the overlay's baseline is the live count, a full scan no longer triggers a re-plan when a store table grows — until `replan-when-a-reported-row-count-drifts` lands. Meanwhile the window is bounded by auto-analyze for this session's own writes.
- Bench: `execution/join-1kx1k@store-mem` re-baselined with `yarn bench:accept` (same rows scanned and sought, instruction order changed). No other counter moved.

## Tests added (each beside what it pins)

- `cardinality-feedback.spec.ts` › precedence › "ranks exact module count, observed, approximate module count, catalog, then default" — one test, one assertion per step of the five-step order, using a memory module whose `getRowCount` answer the test switches.
- `live-row-count-plans.spec.ts` › join selection — an isolated store over an in-memory provider, never analyzed: the filtered join plans an index seek with no hash join, and returns the same 30 rows after `analyze`. Fails with the hook withheld (checked).
- `index-seek-row-estimates.spec.ts` › "does not claim at-most-one-row for a correlated primary-key seek" — the fix's reproduction at the lowest layer: the inner seek's FDs and the join's `keysOf`. Fails without the fix (checked).

Pinned specs updated: `live-row-count-plans.spec.ts` (requests now carry 137 / 100; the ANALYZE test now expects the live count 139; header rewritten). `store-row-count-to-planner.spec.ts`: header only. Its assertions build requests by hand and did not change, contrary to the plan's expectation.

**Key-set pin (`live-row-count-plans.spec.ts`, last block).** The plan predicted the merge-join size gate might now decline. It does not, and it never ran: with the hook withheld and with it, the query reaches `rule-key-set-seek` as a *hash* semi join, and that size gate only guards the merge arm. I re-described the test as a row-set pin, rewrote the NOTE at the gate (`rule-key-set-seek.ts`), and recorded the outcome on `debt-row-estimate-relay-has-no-guard`. No test now exercises the merge gate with a sized key source.

## Known gaps / judgment calls for the reviewer

- **Isolation forward vs. the contract.** The contract says `rows` includes the module's own buffered writes. `IsolationModule` forwards the underlying count, which excludes this connection's uncommitted overlay rows, and still says `exact: true`. The plan chose this ("a plain forward is the honest answer"); it is documented on the forward, in the inventory and in the isolation README. Inside a big uncommitted transaction on an isolated store, plans see the committed size.
- The throw / malformed-answer handling in `reportedRowCount` is checked by reading only (as the plan specified); no test.
- Tripwire `NOTE:` in `record`: a table with an exact module count still records an overlay entry that is never read, costing one slot in the overlay's least-recently-used cache.
- `docs/module-authoring.md` went from 11,915 to 11,901 words (cap 12,000).

## Validation run

`yarn lint` clean; `yarn test` all green (quereus 10,840 + every package suite, 0 failing); `yarn test:store` 10,832 passing, 0 failing (after the seek fix); store and isolation `typecheck` clean; `yarn docs:check` OK; `yarn bench:gate` green after re-baselining one store-mem counter set. Logs: `tickets/.logs/planner-asks-backend.{test,store,bench}.log`.
