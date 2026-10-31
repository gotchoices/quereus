description: Give the query planner a per-database memory of how many rows each table was actually seen to hold, and make every planner reading of a table's size consult it first — so later steps can feed it real counts observed during execution.
architecture: docs/progressive-optimizer.md#33-precedence-one-row-count-per-plan
files: packages/quereus/src/core/database-cardinality-feedback.ts (new), packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/core/database.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts (new), docs/optimizer-costing.md, docs/invariants.md, docs/progressive-optimizer.md
difficulty: medium
----

# The observed row-count overlay and the one row-count seam

First of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3). This ticket builds the planner-side half only: a `Database`-owned overlay of exact table sizes, its record/shift policy, and the precedence seam every planner size read goes through. Nothing in production code records into the overlay yet — `cardinality-feedback-scan-observations` adds the source — so with this ticket alone every plan is unchanged.

## Why a seam, not a stats provider

Today a base table's row count reaches the planner through exactly one function, `catalogRowCount(table)` (`planner/stats/table-cardinality.ts`), read by two callers: `TableReferenceNode.estimatedRows` (the base cardinality of every scan, and the `BestAccessPlanRequest.estimatedRows` hint a module prices its access path against) and `CatalogStatsProvider.tableRows` (selectivity denominators, MV sizing). The node getter has no `OptContext`, so a `StatsProvider` wrapper could not reach it — layering the overlay as a provider would make scan cardinality and selectivity denominators disagree, the exact drift the shared seam exists to prevent. So the overlay plugs into the seam.

## Design

### `ObservedRowCounts` and `plannedRowCount` (`planner/stats/table-cardinality.ts`)

```ts
/** Exact table sizes observed during execution. Answers only for the TableSchema object the count was observed against. */
export interface ObservedRowCounts {
	observedRows(table: TableSchema): number | undefined;
}

/** The base-table row count the planner uses: observed, else catalog (ANALYZE), else undefined (unknown). */
export function plannedRowCount(table: TableSchema, observed: ObservedRowCounts | undefined): number | undefined {
	return observed?.observedRows(table) ?? catalogRowCount(table);
}
```

`undefined` stays the only spelling of unknown — no default is folded in here; callers keep their own (`NaiveStatsProvider` 1000, the `|| 1000` sites). The overlay wins over the catalog because an entry only answers for the exact `TableSchema` object it was observed under, and any `ANALYZE` swaps that object — so an answering entry is always newer than the catalog numbers on the schema it names. Only the row count is overridden; column statistics (distinct/null counts, histograms) are untouched.

### Readers

- `TableReferenceNode` computes its estimate **once, in the constructor** — `plannedRowCount(tableSchema, schemaManager?.getObservedRowCounts())` — and `estimatedRows` returns the stored value. Plan nodes are immutable (OPT-008); a node built before an observation keeps the number its plan was costed with. A node built without a `SchemaManager` (isolated tests) reads the catalog only. The four construction sites (`building/table.ts`, two in `scopes/global.ts`, `rules/cache/rule-materialized-view-rewrite.ts`) already pass the schema manager, so none changes.
- `SchemaManager.getObservedRowCounts(): ObservedRowCounts | undefined` returns the owning database's overlay (`this.db._cardinalityFeedback`). Read lazily at node construction, so construction order inside the `Database` constructor does not matter.
- `CatalogStatsProvider` takes the overlay as an optional second constructor argument; `tableRows(table)` becomes `plannedRowCount(table, this.observed) ?? this.fallback.tableRows(table)`. `Database` constructs the overlay first and passes `new CatalogStatsProvider(undefined, overlay)` into `new Optimizer(DEFAULT_TUNING, …)` (the constructor already accepts a provider). Building and optimizing run in one synchronous `Statement.compile()`, so the provider's read and the node's construction-time snapshot cannot see different overlay states.
- Every other `catalogRowCount` caller — `database-assertions.ts`, `database-watchers.ts`, `schema/lens-prover.ts`, `database-auto-analyze.ts` — stays catalog-only. Leave a one-line `NOTE:` at the seam saying so.

### `CardinalityFeedbackManager` (`core/database-cardinality-feedback.ts`, new)

Mirrors `database-auto-analyze.ts`: a class constructed with a small context interface (schema manager, a tuning getter returning `db.optimizer.tuning`, and an `onShift(key)` callback), owned by `Database`, exposed as `Database._cardinalityFeedback`, disposed in `Database.close()` next to `autoAnalyzeManager.dispose()`.

- **Entries:** `Map<string, Entry>` keyed by lowercased `<schema>.<table>` (the change-log / work-counter convention), `Entry = { schema: TableSchema; rows: number; baselineRows: number; observations: number; shifts: number }`.
- **`observedRows(table)`** (implements `ObservedRowCounts`): the entry's `rows` iff `entry.schema === table`; otherwise `undefined`. A hit refreshes LRU position (delete + re-set on the `Map`).
- **`record(table, rows)`** — the policy, with tuning `cardinalityFeedback.{minRows, shiftFactor, maxTables}` and `defaultRowEstimate`:
  - Ignore when `table` is no longer the catalog's current object for its name (`schemaManager.findTable(name, schemaName) !== table`) — an observation made under a superseded schema describes nothing current.
  - `before` = valid entry's `rows` ?? `catalogRowCount(table)` ?? `defaultRowEstimate`.
  - Ignore when `max(before, rows) <= minRows` (both small: plan choice is indifferent, and small tables keep the numbers they plan with today).
  - Otherwise upsert: a new entry starts with `baselineRows = before`; set `rows`, `observations++`.
  - **Shift** when `spread(rows, baselineRows) >= shiftFactor`, where `spread(a, b) = (max(a, b) + 1) / (min(a, b) + 1)`: set `baselineRows = rows`, `shifts++`, call `onShift(key)`. In this ticket `Database` passes a callback that only debug-logs; `cardinality-feedback-replan` wires it to statement re-planning.
  - Enforce `maxTables` by evicting the least-recently-used entry. Eviction calls no `onShift` — existing plans keep their snapshot, the next compile falls back to catalog/default.
- **Eviction on schema change:** subscribe to `schemaManager.getChangeNotifier()`; on `table_modified` / `table_removed` drop the named table's entry. This is memory hygiene — the identity check in `observedRows` is the correctness guard (`DETACH` fires no per-table events; its stale entries simply never match and age out under LRU).
- **`clear()`** (used by the option toggle in the next ticket) and **`snapshot()`** — a by-value list of valid entries with `catalogRows: catalogRowCount(current schema)`, for tests now and the `cardinality_feedback()` TVF later.

### Tuning (`planner/optimizer-tuning.ts`)

Add `cardinalityFeedback: { minRows: 1000, shiftFactor: 10, maxTables: 512 }` to `OptimizerTuning` / `DEFAULT_TUNING`, each field doc-commented with its role from the policy above. (`replanCooldown` arrives with `cardinality-feedback-replan`.)

## Edge cases & interactions

- **Empty overlay changes nothing.** With no records every `plannedRowCount` equals `catalogRowCount`. Verify: full `yarn test` passes with no plan expectation edited.
- **Schema identity.** An entry recorded under schema object A answers `undefined` for its successor B after `analyze t` (or any ALTER), and the listener removes it. Verify: test.
- **Snapshot immutability.** A `TableReferenceNode` built before a `record()` keeps its old estimate; nothing reads the overlay after construction. Verify: inspection (no overlay read outside the constructor).
- **Node minted during optimization** (`rule-materialized-view-rewrite`) snapshots inside the same synchronous compile as the provider reads. Verify: inspection.
- **Provider/node agreement** is now a register-worthy invariant (both readers go through `plannedRowCount`). Verify: register it (TODO) with the integration test as its guard.
- **Record floor, shift hysteresis, zero counts, LRU cap, superseded-schema observations.** Branching logic with a stated contract. Verify: the policy test.
- **Column statistics unaffected.** Selectivities still come from the catalog / naive provider; only cardinality moves. Verify: inspection; the integration test uses a table with no column statistics.
- **Module access-path hint.** The overlay value now reaches `getBestAccessPlan` as `request.estimatedRows`. `StoreModule` honors a supplied hint over its own running count (`sizeRequestFromLiveCount`, `quereus-store/src/common/store-module.ts`), so between full scans it prices against the last observed size instead of its live one — accepted for one-size-per-plan consistency. Verify: record it as an accepted-tradeoff `NOTE:` at `plannedRowCount` (revisit when a module's live size reaches the planner, `feat-planner-asks-the-backend-how-big-a-table-is`).
- **Measured zero.** A recorded `0` reaches the `|| 1000` sites (`rule-select-access-path`, `rule-grow-retrieve`, `IndexSeekNode`) and collapses to 1000 exactly as an analyzed zero does (`bug-measured-empty-table-costed-as-thousand-rows`); not this ticket's fix. Verify: inspection.
- **DDL gates that read sizes.** The materialized-view strategy cost gate and create-time size reject (`core/database-materialized-views-plan-builders.ts`, `statsProvider.tableRows`) become overlay-aware, so an observed size can decide them — the same history dependence auto-analyze already has. Verify: inspection; one sentence in `docs/optimizer-costing.md`.
- **Auto-analyze in tests.** Bulk-loading a test table arms a background `ANALYZE` (`auto_analyze` defaults on) that swaps the schema and voids recorded entries mid-test. Verify: tests set `pragma auto_analyze = false` before loading data.
- **Database lifecycle.** The listener is removed and entries cleared on `close()`; each `Database` owns its own overlay, so two instances never share counts. Verify: inspection.

## Tests (only these)

`packages/quereus/test/optimizer/cardinality-feedback.spec.ts`:

- **Policy contract** (drive `db._cardinalityFeedback.record()` directly; `pragma auto_analyze = false`): `max(before, n) <= 1000` is ignored; a never-analyzed table observed at 20,000 records and shifts (baseline was the 1000 default); a later 50,000 records silently (2.5× from baseline 20,000); 250,000 shifts again (12.5× — keep test values clear of the 10× boundary, since `spread` adds 1 to both sides); a following 0 shifts; an observation under a superseded schema object is ignored; with `maxTables` lowered to 2 the least-recently-used entry is evicted without a shift; `analyze t` voids the entry.
- **Precedence reaches the plan:** tables `big (id integer primary key, v integer, w integer)` loaded with 20,000 rows and `mid (id integer primary key, big_id integer, x integer)` with 300 rows, never analyzed. Planning `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` gives a `HashJoin` over a full `IndexScan` of `big`. After `record(big, 20000)` a fresh plan of the same SQL has a nested-loop `Join` with an `IndexSeek` on `big` and no `HashJoin` (verified during planning with only `big`'s row count known: the shape flips). Assert via plan shape (`db.prepare(sql).getPlanShape().nodeTypes`), not costs.

## TODO

- Add `ObservedRowCounts` + `plannedRowCount` to `table-cardinality.ts`, with the catalog-only `NOTE:` for the other callers and the accepted-tradeoff `NOTE:` for the module hint; update the file's header comment.
- `TableReferenceNode`: snapshot the planned count in the constructor; `estimatedRows` returns it.
- `SchemaManager.getObservedRowCounts()`.
- `CatalogStatsProvider` optional overlay argument; `tableRows` through `plannedRowCount`.
- `core/database-cardinality-feedback.ts`: manager with entries, `observedRows`, `record` policy, LRU, schema-change eviction, `clear`, `snapshot`, `dispose`.
- `Database`: construct the manager before the optimizer, pass the provider, expose `_cardinalityFeedback`, debug-log `onShift`, dispose on close.
- `cardinalityFeedback` tuning block in `optimizer-tuning.ts`.
- Tests above.
- `docs/optimizer-costing.md`: rewrite "Base-table row estimates" and "Where a module's own size fits" for the new precedence; note the MV gate interaction.
- `docs/invariants.md`: add an OPT entry "one base-table row count per plan" (code: `plannedRowCount`, `TableReferenceNode`, `CatalogStatsProvider.tableRows`; guard: the precedence test; doc: the costing section).
- `docs/progressive-optimizer.md` §3.2–3.4: present tense for what landed; adjust the status note.
- `yarn lint`, `yarn build`, `yarn test`.
