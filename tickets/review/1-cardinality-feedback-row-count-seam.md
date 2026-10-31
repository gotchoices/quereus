description: Review the planner's new per-database memory of observed table sizes and the single place every planner size reading now consults it — nothing records into it yet, so plans are unchanged.
architecture: docs/progressive-optimizer.md#33-precedence-one-row-count-per-plan
files: packages/quereus/src/core/database-cardinality-feedback.ts (new), packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/core/database.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (comment only), packages/quereus/test/optimizer/cardinality-feedback.spec.ts (new), docs/optimizer-costing.md, docs/invariants.md, docs/progressive-optimizer.md
----

# The observed row-count overlay and the one row-count seam — review handoff

First of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3). Planner-side half only: a `Database`-owned map of exact table sizes ("the overlay"), its record/shift policy, and the precedence function every planner size read goes through. No production code calls `record()` yet (`cardinality-feedback-scan-observations` adds that), so every plan is unchanged — the full suite passed with no plan expectation edited.

## What landed

- **Seam** (`planner/stats/table-cardinality.ts`): `ObservedRowCounts` interface + `plannedRowCount(table, observed)` = observed ?? `catalogRowCount` ?? `undefined`. Catalog-only `NOTE:` on `catalogRowCount` (assertions, watchers, lens prover, auto-analyze stay catalog-only); accepted-tradeoff `NOTE:` on `plannedRowCount` for the `StoreModule` hint (it prices against the last observed size instead of its live count; revisit with `feat-planner-asks-the-backend-how-big-a-table-is`).
- **Readers**: `TableReferenceNode` snapshots `plannedRowCount(tableSchema, schemaManager?.getObservedRowCounts())` once in its constructor; `estimatedRows` returns the stored value. `CatalogStatsProvider` takes the overlay as optional second constructor arg; `tableRows` goes through the seam. `Database` passes `new CatalogStatsProvider(undefined, overlay)` to `new Optimizer(...)`. `SchemaManager.getObservedRowCounts()` reads `db._cardinalityFeedback` lazily.
- **Manager** (`core/database-cardinality-feedback.ts`, `CardinalityFeedbackManager`): context `{ schemaManager, getTuning, onShift }`; entries keyed lowercased `schema.table`, `Map` insertion order = LRU recency (hit/record re-inserts). `observedRows` answers only when `entry.schema === table`. `record` policy: ignore if `findTable(name, schema) !== table`; `before` = valid entry rows ?? catalog ?? `defaultRowEstimate`; ignore when `max(before, n) <= minRows`; upsert (new baseline = `before`); evict LRU past `maxTables` (no `onShift`); shift when `(max+1)/(min+1) >= shiftFactor` → baseline = n, `shifts++`, `onShift(key)`. Schema listener drops the entry keyed by `event.oldObject` on `table_modified`/`table_removed` (oldObject, because a rename event carries the NEW name). `clear()`, `snapshot()` (valid entries by value, with `catalogRows`), `dispose()`.
- **Database**: manager constructed before the optimizer; `onShift` only debug-logs (`log('Observed row count for %s shifted')`) — `cardinality-feedback-replan` replaces it; `_cardinalityFeedback` getter; disposed in `close()` after auto-analyze.
- **Tuning**: `cardinalityFeedback: { minRows: 1000, shiftFactor: 10, maxTables: 512 }`, doc-commented.
- **Docs**: costing doc's "Base-table row estimates" and "Where a module's own size fits" rewritten for the precedence, plus a "DDL decisions read the same number" paragraph (MV gate); new invariant **OPT-062 — One base-table row count per plan**; progressive-optimizer status note, §2 seam mention, §3.3 present tense, §3.4 gained the superseded-schema "Ignore" bullet, key-files table. `yarn docs:check` passes.

## Tests added (`test/optimizer/cardinality-feedback.spec.ts`)

- `records past the floor and shifts only on a 10x move from the baseline` — floor ignore (1000 vs default 1000), 20,000 shifts (baseline = default), 50,000 silent (2.5×), 250,000 shifts (12.5× from baseline, not from 50,000), 0 shifts; final `snapshot()` contents.
- `answers only for the schema object it observed, and ignores superseded ones` — `analyze t` swaps the schema → old entry inert; a `record` against the superseded object is ignored.
- `evicts the least-recently-used table past maxTables, without a shift` — `maxTables: 2`, a hit refreshes recency, eviction calls no `onShift`.
- `an observed size reaches the plan: the join flips from hash to a primary-key seek` — guard for OPT-062. `HashJoin` + `IndexScan` before; after `db._cardinalityFeedback.record(big, 20000)` a fresh prepare gives `Join` + `IndexSeek`, no `HashJoin`.

The three policy tests construct their own `CardinalityFeedbackManager` over `db.schemaManager` (instead of driving `db._cardinalityFeedback` as the ticket suggested) so `onShift` calls can be captured directly and tuning varied per test.

## Deviations / known gaps — check these

- **Precedence test uses empty tables.** The ticket said to load 20,000 / 300 rows. Plan shape depends only on estimates (the memory module does not read its live size), so loading adds ~400 ms and verifies nothing more. I confirmed by temporarily loading the data: identical shapes, test passed. Reinstate the load if you disagree.
- **No test for listener eviction itself** — only the identity guard is tested (`snapshot()` filters invalid entries too, so it cannot see whether the listener ran). The listener is hygiene; correctness doesn't depend on it.
- **`record()` after `dispose()`** would re-populate entries (no `disposed` flag). Unreachable today (no production caller); the scan-observation ticket's sink should not publish into a closed database anyway — worth a look when that lands.
- **`observedRows` refreshes LRU on every planner read** (node construction + provider), i.e. a few `Map` delete/set per table per compile. Not measured; assumed negligible.
- **Duplicate-ish shift logging**: the manager debug-logs each recorded observation (marking shifts), and Database's `onShift` logs the key again. Goes away when re-planning wires `onShift`.
- **Measured zero** still collapses to 1000 at the `|| 1000` sites (`bug-measured-empty-table-costed-as-thousand-rows`) — unchanged, by design.
- Inspection-only items from the ticket (no overlay read outside the `TableReferenceNode` constructor; MV-rewrite-minted nodes snapshot inside the same synchronous compile; column statistics untouched) — I checked them; the reviewer should re-check.

## Validation run

`yarn workspace @quereus/quereus run lint` (exit 0), `yarn build` (exit 0), `yarn test` — all workspaces pass (quereus 10,823 passing, 0 failing), `yarn docs:check` OK.
