description: The planner now keeps a per-database memory of observed table sizes and reads every table size through one place that prefers that memory over ANALYZE numbers; nothing records into it yet, so plans are unchanged.
architecture: docs/progressive-optimizer.md#33-precedence-one-row-count-per-plan
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/core/database.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/optimizer-costing.md, docs/invariants.md, docs/progressive-optimizer.md, docs/module-authoring.md, docs/optimizer-joins.md
----

# The observed row-count overlay and the one row-count seam

First of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3). Landed in `ticket(implement): cardinality-feedback-row-count-seam`, reviewed here.

## What landed

- **The seam** — `plannedRowCount(table, observed)` in `planner/stats/table-cardinality.ts`: the overlay's exact observed count for this exact `TableSchema` object, else the catalog (`ANALYZE`) count, else `undefined`. `catalogRowCount` stays for the deliberately catalog-only readers (assertions, watchers, lens prover, auto-analyze), with a `NOTE:` saying so.
- **Both planner readers use it** — `TableReferenceNode` snapshots the value once in its constructor (plan nodes are immutable); `CatalogStatsProvider.tableRows` takes the same overlay as its second constructor argument, injected by `Database` when it builds the `Optimizer`. Invariant **OPT-062 — One base-table row count per plan**.
- **The overlay** — `CardinalityFeedbackManager` (`core/database-cardinality-feedback.ts`): entries keyed lowercased `schema.table`, valid only for the `TableSchema` object observed under; record policy (ignore superseded schema, ignore when both before and observed are ≤ `minRows`, upsert, LRU-evict past `maxTables`, shift on a `shiftFactor` spread from the baseline → `onShift`); a schema listener drops entries on `table_modified` / `table_removed`; `clear`, `snapshot`, `dispose`.
- **Tuning** — `cardinalityFeedback: { minRows: 1000, shiftFactor: 10, maxTables: 512 }`.
- `Database.onShift` only debug-logs until `cardinality-feedback-replan` wires re-planning. No production caller of `record()` until `cardinality-feedback-scan-observations`.

## Review findings

Read the implement diff first, then the handoff; ran the spec under mutation, lint, docs check and the full quereus suite.

- **Test gap — fixed.** The OPT-062 guard (`an observed size reaches the plan…`) still passed with the overlay removed from `CatalogStatsProvider` (verified by temporarily constructing it without the overlay): the hash→seek flip is driven by the scan estimate alone, so the guard covered only half the invariant it is named for. Added one assertion that `db.optimizer.getStats().tableRows(big)` returns the observed 20,000; re-ran the mutation and it now fails (`expected 1000 to equal 20000`). The node half is covered by the plan flip itself.
- **Stale docs — fixed.** `docs/module-authoring.md` said `request.estimatedRows` is "populated only from `ANALYZE`-collected statistics" and that `undefined` means "a table nobody has analyzed" — now names the observed size first and says "whose size nobody has measured". `docs/optimizer-joins.md` (fan-out cross guard, batched-outer gate) said "a never-`ANALYZE`d leaf reports `undefined`" — now "an unmeasured leaf (never `ANALYZE`d, no observed size)". Other docs the change touches (`optimizer-costing.md`, `progressive-optimizer.md`, `invariants.md`) read correctly; `yarn docs:check` OK.
- **Wiring checks — no defect.** All four `TableReferenceNode` construction sites (`building/table.ts`, `scopes/global.ts` ×2, `rule-materialized-view-rewrite.ts`) pass a `SchemaManager`, so none silently reads catalog-only. Only `Database` constructs a production `CatalogStatsProvider`/`Optimizer`; MV plan builders read `ctx.optimizer.getStats()`, so the MV cost gate sees the overlay as documented. `updateOptimizerTuning` replaces tuning only, and the manager reads tuning per record, so it takes effect immediately. `committed.`-schema references resolve to the same `TableSchema` object, so they hit the same entry.
- **Column statistics untouched — confirmed.** The one other `rowCount` read in `catalog-stats.ts` (selectivity floor `1 / stats.rowCount`) is inside the catalog's own column-statistics fraction, consistent with "only the row count is overridden".
- **`record()` after `dispose()` — not a defect.** The handoff flagged no `disposed` flag; `Database.close()` runs `schemaManager.clearAll()` right after disposing, so any later `record()` fails the superseded-schema identity check and is ignored. No action.
- **Input validation — considered, declined.** `record()` would accept `NaN`/negative counts (`NaN <= minRows` is false, so it would record). The only intended caller is a scan-loop counter, which cannot produce either; no guard added. The scan-observation implementer should pass the counter directly.
- **`maxTables: 0` edge — considered, no action.** The new entry is evicted immediately yet `onShift` still fires; a misconfiguration whose only effect is a no-op re-plan once re-planning lands.
- **Handoff deviations — agreed.** Empty tables in the precedence test (plan shape depends only on estimates; the memory module does not read its live size). No test of listener eviction (hygiene only; the identity check is the correctness guard and is tested). LRU refresh on every planner read is a couple of `Map` ops per table per compile — not measured, not worth measuring. Duplicate shift logging disappears when `cardinality-feedback-replan` replaces `onShift`.
- **Tests — no cuts.** The three policy tests pin named specification branches (floor, baseline-relative shift, identity guard, LRU without shift) on real branching logic; the precedence test is OPT-062's guard.
- **Tripwires — none added.** Nothing conditional surfaced that is not already recorded by the implementer's `NOTE:`s (catalog-only readers; the `StoreModule` live-count accepted tradeoff, revisit with `feat-planner-asks-the-backend-how-big-a-table-is`).
- **Tickets filed — none.** No major findings.

## Validation

`yarn workspace @quereus/quereus run lint` exit 0; `yarn docs:check` OK; `yarn workspace @quereus/quereus run test` — 10,823 passing, 0 failing, 25 pending. Other workspaces not re-run: this pass changed only one quereus spec assertion and two docs (the implement pass ran the full `yarn test` green).
