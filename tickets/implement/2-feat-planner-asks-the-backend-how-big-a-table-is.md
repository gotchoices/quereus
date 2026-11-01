description: When a storage backend already keeps a running count of a table's rows, the query planner should ask for it while planning instead of assuming a made-up default until someone runs the `analyze` maintenance command or a query happens to read the whole table.
architecture: docs/progressive-optimizer.md#33-precedence-one-row-count-per-plan
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus-store/test/live-row-count-plans.spec.ts, packages/quereus-store/test/store-row-count-to-planner.spec.ts, packages/quereus-isolation/README.md, docs/progressive-optimizer.md, docs/optimizer-costing.md, docs/module-capabilities.md, docs/module-authoring.md
difficulty: medium
----

# The planner asks the module how big a table is

## What happens today (verified 2026-11-01)

The planner reads a base table's size through one seam, `plannedRowCount(table, observed)` (`planner/stats/table-cardinality.ts`): the observed row-count overlay (an exact count seen by a complete scan this session), else the catalog count `ANALYZE` stored, else `undefined`. Both planner readers call it — `TableReferenceNode` at construction and `CatalogStatsProvider.tableRows` — so scan cardinality and selectivity denominators agree (invariant OPT-062 in `docs/invariants.md`).

A module's own count never reaches that seam. `StoreModule` maintains a running count on every write path and substitutes it into `BestAccessPlanRequest.estimatedRows` when the planner sends none (`sizeRequestFromLiveCount`, `quereus-store/src/common/store-module.ts`), so a store table's *access path* is priced against its real size — but join selection, cache admission, sort costs and every other consumer read `plannedRowCount` and see `undefined`, then a default (`|| 100` in join selection, 1000 elsewhere). Measured on an isolated store module over an in-memory provider, never analyzed, 20,000-row `big`, 300-row `mid`: `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` plans a hash join over a full scan of `big` that the store itself prices at 20,000 (26.6 ms median); after `analyze`, a nested-loop join seeking `big` by primary key (0.46 ms).

Corrections to the backlog ticket this replaces: the "related work" it cites has landed (`unknown-row-count-stops-pretending-to-be-zero`, `ask-the-backend-before-guessing-its-size`, the cardinality-feedback chain); the seam is `plannedRowCount`, not `catalogRowCount`; `VirtualTable.getStatistics()` is still called only by `ANALYZE`.

## Decisions

### A synchronous, I/O-free module hook

New optional `VirtualTableModule.getRowCount?(db: Database, table: TableSchema): ModuleRowCount | undefined`, with `interface ModuleRowCount { readonly rows: number; readonly exact: boolean }` exported beside it. Module-level, like `getBestAccessPlan`, because planning holds no connected table instance; synchronous, because planning performs no I/O (`docs/progressive-optimizer.md` §1). Contract:

- answer only from memory, in constant time, or return `undefined` (decline) — never start I/O;
- `rows` is the count a read issued now by this database would see; a module that buffers its own transaction's writes includes them (the store's `getKnownRowCount()` already does, and its access-path pricing uses the same number, so the two cannot disagree);
- `exact: true` only for a count the module maintains on every write path; anything sampled, cached from elsewhere, or otherwise estimated is `exact: false`;
- a hint: correctness never depends on it.

`VirtualTable.getStatistics()` is not used: it needs a connected instance and may be asynchronous.

### Precedence — exact module count, overlay, approximate module count, catalog

`plannedRowCount` becomes, in order:

1. an **exact** module count — the truth now; any snapshot is older;
2. the overlay's observed count;
3. an **approximate** module count;
4. the catalog (`ANALYZE`) count;
5. `undefined`.

This decides the question the progressive-optimizer doc left open (§3.3 said a module's live size "should outrank the overlay"): only an exact one does. An approximate count can be off by more than the 10× shift factor, and a complete scan's observation is the only thing that can correct it, so a measurement this session made outranks an estimate. An approximate count still outranks the catalog: `ANALYZE` is the rare, unaffordable operation in the remote deployments this targets, and a live estimate describes the table now where a snapshot may be arbitrarily old (an exact observation outranks the catalog for the same reason today). Only the row count is overridden; column statistics still come from the catalog.

The seam takes one sources object instead of the bare overlay — `{ observedRows(table), reportedRows(table) }` — constructed once per `Database`, injected into `CatalogStatsProvider` and exposed by `SchemaManager` (replacing `getObservedRowCounts`), so both readers see one source exactly as today. `reportedRows` resolves the table's module through `schemaManager.getModule(table.vtabModuleName)`, calls the hook inside a try/catch, and treats a throw or a malformed answer (non-finite, negative, non-integer `rows`) as `undefined` with a debug log — a failed hint must never fail planning. Consult the module first so an exactly-sized table never touches the overlay (whose reads refresh LRU recency).

### Module implementations

- `StoreModule.getRowCount`: `this.getTable(schema, name)?.getKnownRowCount()` → `{ rows, exact: true }`, or `undefined` when the table has no count in memory yet (never primed). One method; `store-module.ts` has room, `store-table-base.ts` (oversized list) needs no change.
- `IsolationModule`: forward to the underlying module when it implements the hook (the overlay holds only this connection's uncommitted rows, which the underlying store does not count — a plain forward is the honest answer). `isolation-module.ts` is on the oversized list: the forward and its doc comment, nothing else.
- `MemoryTableModule`: **not** implemented here. Answering from `getBaseLayerStats()` would re-price every never-analyzed memory table under the whole test suite; that is `feat-memory-backend-sizes-itself` (backlog), which should now implement this hook.

### The overlay's notion of "before"

`CardinalityFeedbackManager.record` measures shifts from `before` = what planning would use right now. Make that `plannedRowCount(table, sources) ?? tuning.defaultRowEstimate`, so a complete scan of an exactly module-sized table compares against the module count (spread ≈ 1, no shift, no wasted re-plan) and an approximately-sized one against whatever outranks it. The manager reaches the sources through its context.

## Edge cases & interactions

- **One size per plan.** `TableReferenceNode` snapshots `plannedRowCount` at construction and `CatalogStatsProvider` reads it during the same synchronous `compile()`; no write can interleave, so a module count cannot differ between the two reads. Verify: inspection.
- **Precedence branches** (exact module beats overlay; overlay beats approximate module; approximate module beats catalog; a declining module falls through). Verify: the unit test below.
- **Throwing or malformed hook.** Logged and ignored. Verify: inspection.
- **Isolated store** (the configuration `yarn test:store` uses). Verify: the end-to-end test below runs through `createIsolatedStoreModule`.
- **Pinned store behaviors that change by design** — update each with the new expectation and say so in the handoff:
  - `live-row-count-plans.spec.ts` "counts what the open transaction has written": the planner now *sends* the live count (100) instead of `undefined`; the module's answer is unchanged.
  - `live-row-count-plans.spec.ts` "defers to ANALYZE, which wins over the live count": an exact module count now outranks the `ANALYZE` snapshot (139, not 137).
  - `live-row-count-plans.spec.ts` "still proceeds on an un-analyzed key source": `IndexScanNode` relays `TableReferenceNode.estimatedRows`, which now carries the store's count, so `rule-key-set-seek`'s merge gate finally sees the 3,000-row key source and may decline — the test's own comment says it pins observed, not desired, behavior. The row set must not change. Note the outcome on `debt-row-estimate-relay-has-no-guard`.
  - `store-row-count-to-planner.spec.ts` request-shape assertions, same reason as the first bullet.
- **Materialized views.** The create-time strategy gate and its full-rebuild size reject read `CatalogStatsProvider.tableRows`, so a full-rebuild-only body over a store table above `materialized_view_rebuild_row_threshold` (10,000) is now rejected at create where the gate used to read 1000. That is the gate working as designed; call it out in the handoff for the release notes. Verify: `yarn workspace @quereus/store test` (`mv-store-backing.spec.ts`), `yarn test:store`.
- **`cardinality_feedback` does not gate module counts.** The option governs the overlay (history-dependent learning); a module count is the backend's own statistic, data-dependent like `ANALYZE` and like the store's access-path sizing today, which no option gates either. Verify: inspection; state it in `docs/progressive-optimizer.md` §3.7.
- **Stale plans.** A prepared statement keeps the count it compiled with; until `replan-when-a-reported-row-count-drifts` lands, a store table that grows 10× does not re-plan cached statements (a complete scan no longer shifts it either, because `before` is now the live count). Bounded meanwhile by auto-analyze for this session's own writes. Verify: inspection; say so in the handoff.
- **Catalog-only readers stay catalog-only** — assertion and watcher delta sizing, the lens prover's cardinality band, auto-analyze's staleness arithmetic. Verify: inspection.
- **Memory backend unchanged.** No `getRowCount` → `yarn test` plans unchanged. Verify: `yarn test`, `yarn bench:gate` (foreground, ~35 s). `store-mem` counter sets may change (their tables are now sized); re-baseline with `yarn bench:accept --reason "…" --allow-dirty` only for those, per `docs/benchmarking.md`.
- **`yarn test:store`** runs the sqllogic corpus on store tables, now sized at plan time; results must not change. Verify: `yarn test:store` (foreground).

## Tests (only these)

- `packages/quereus/test/optimizer/cardinality-feedback.spec.ts`, `describe('precedence')`: a memory-backed test module whose `getRowCount` answer is switchable (exact / approximate / declining), plus an overlay record and an `ANALYZE`d catalog count, asserting `db.optimizer.getStats().tableRows(t)` walks the five steps. One test, one assertion per branch.
- `packages/quereus-store/test/live-row-count-plans.spec.ts`: never-analyzed isolated store tables `big` (20,000) and `mid` (300) — the filtered join above plans `Join` + `IndexSeek` on `big` with no `HashJoin`, and returns the same rows as with `analyze`.

## TODO

- `ModuleRowCount` and `VirtualTableModule.getRowCount` (doc comment carrying the contract above).
- Row-count sources object; `plannedRowCount` precedence; `CatalogStatsProvider` and `TableReferenceNode` take the sources; `SchemaManager.getRowCountSources()` replaces `getObservedRowCounts()`.
- `record`'s `before` through the seam.
- `StoreModule.getRowCount`; `IsolationModule` forward.
- Rewrite the accepted-tradeoff NOTE at `plannedRowCount` and the doc comment of `sizeRequestFromLiveCount` (its substitution now fires only when the hook declines).
- The two tests; update the pinned store specs listed above.
- Docs: `docs/progressive-optimizer.md` §2 (module access-path sizing bullet), §3.3 (precedence), §3.7 (determinism), §5 (trim the "Module-reported table sizes" item to the drift re-plan); `docs/optimizer-costing.md` § Base-table row estimates and "Where a module's own size fits"; `docs/module-capabilities.md` § Surface inventory (a `getRowCount` row: contract, fallback, store and isolation columns); `packages/quereus-isolation/README.md` "Transparent hook forwarding". `docs/module-authoring.md` is 85 words under its 12,000-word cap with no grace band: correct its two now-wrong sentences (the `estimatedRows` hint paragraph in § Index-Based Access and the `getStatistics` paragraph saying nothing sizes a table during planning) in place, pointing at the inventory, without growing it — or move a section to a satellite first.
- `yarn lint`, `yarn test`, `yarn workspace @quereus/store test`, `yarn workspace @quereus/isolation test`, `yarn test:store`, `yarn bench:gate`, `yarn docs:check`.
