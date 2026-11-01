description: When a query reads only part of a table — stopping after a LIMIT, or reading one range of an index — the rows it did read now prove the table holds at least that many; the planner remembers that floor so a table already shown to be large is no longer planned as small or of unknown size.
prereq: feat-planner-asks-the-backend-how-big-a-table-is
architecture: docs/progressive-optimizer.md#31-what-is-observed
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md, docs/optimizer-costing.md, docs/usage.md, docs/optimizer.md
----

# Cardinality feedback: lower bounds from partial reads

## What landed

Implemented in `ticket(implement): cardinality-feedback-lower-bounds`.

A scan invocation that walks one window of a table (full scan, or one index `scan` / `eqSeek` / `rangeSeek` / `prefixRangeSeek`, primary or secondary, partial index included) and either finishes or is closed early by its consumer (`LIMIT`, `get()`, `EXISTS`) records "this table holds at least N rows". A whole-table site that completes still records an exact count. Errors and aborts record nothing; sites with a runtime `FilterInfo` override record nothing; multi-seeks are excluded (they can yield a row twice).

- Scan leaf (`runtime/emit/scan.ts`): `walksOneWindow` emit-time predicate beside `enumeratesWholeTable`; recording moved into `finally` behind `completed` / `threw` locals plus a signal-aborted check. Per-row loop unchanged.
- Sink (`runtime/cardinality-observations.ts`): `observeAtLeast` keeps the largest single invocation per table, drops floors at or below `minRows` before touching its map; `lowerBounds()` skips tables counted exactly in the same execution.
- Overlay (`core/database-cardinality-feedback.ts`): entries `{ rows?, atLeast?, baselineRows, observations, shifts }`; `recordAtLeast` records only above both the current planned estimate and `minRows`, shifts like a count; an exact `record` clears `atLeast`. Held transaction observations carry both kinds; count applied before floor everywhere.
- Seam (`planner/stats/table-cardinality.ts`): `observedRows` returns `{ rows?, atLeast? }` (the entry itself, no allocation); `plannedRowCount` = `max(atLeast, observed ?? approximate module ?? catalog)`, never raising an exact module count.
- Diagnostics: `cardinality_feedback()` gains nullable `lower_bound_rows`; `observed_rows` becomes nullable.

## Review findings

Read the implement diff first, then the handoff. Lint (`yarn lint` in `packages/quereus`), `yarn test` in `packages/quereus` (10,846 passing, 0 failing) and `yarn docs:check` all pass after review edits. `yarn test:store` and the bench were not re-run in review; the only review code change is a comment.

- **Correctness — scan leaf.** Checked every exit path of the generator: natural exhaustion (exact at whole-table sites, floor elsewhere), consumer `return()` (floor), in-loop throw incl. `AbortError` (nothing, via `threw`), downstream abort closing via `return()` (nothing, via `signal.aborted`), connect failure (before the `try`, so no recording — correct). Dynamic seek args only replace `args`, never the access-path shape, so the emit-time decision holds at run time. Pushed `offset` / module-internal filtering only make a floor smaller, never wrong. No defect found.
- **Correctness — overlay policy.** Walked `record` / `recordAtLeast` through: floor at/below default ignored; floor above an exact count raises; a later lower exact count clears the floor and shifts against the raised baseline (correct — planning really drops); repeated identical `LIMIT` floors are ignored after the first (no oscillation). No defect found.
- **Held-observation ordering (considered, no change).** Inside one transaction a floor from an earlier statement survives a later exact count (`holdAll` keeps both, commit applies count then floor), whereas autocommit would let the later count clear it. A floor exceeding a same-transaction exact count needs the table to change without this transaction writing it, which the single-writer model rules out, so the divergence is unreachable; left as is.
- **Tripwire — multi-valued indexes.** `walksOneWindow` assumes an index holds each row at most once (true of the memory and store modules). Parked as a `NOTE:` on `walksOneWindow` in `runtime/emit/scan.ts`.
- **Docs.** The implementer updated `progressive-optimizer.md` and `functions.md`; three docs that describe the feature were still exact-count-only and are now fixed: `docs/optimizer-costing.md` (base-table row-estimate seam — added the floor rule after the precedence list), `docs/usage.md` (`cardinality_feedback` option description), `docs/optimizer.md` (index row and progressive-strategy paragraph).
- **Tests.** The two new scan tests (LIMIT floor; secondary-index range seek floor, whose exact 6000 also proves the seek path was taken) and the policy test (each branch of `recordAtLeast` plus the exact-count interaction, read through `CatalogStatsProvider.tableRows`) each pin specified behaviour with real branching; kept. Adjusted existing tests only change the read shape. No tests cut, none added — no defect found that a test would reproduce.
- **Known gaps accepted from the handoff.** No end-to-end "floor changes a compiled plan" test (precedence is pinned at `tableRows`, the same seam the node reads, and the existing plan-flip test covers that reader); transaction rules for floors verified by inspection — they share the count code paths. A floor at a module-exact table can occupy an LRU slot; already covered by the existing `NOTE:` on `record`.
- **Type safety / resource cleanup / performance.** No `any`; `observedRows` hands out the live entry typed as a readonly view, read immediately by the only caller. No new resources; the `finally` ordering keeps row-slot close and disconnect unchanged. Per-invocation cost is one comparison for sub-floor seeks; implementer's bench run (recorded in progressive-optimizer.md §3.8) showed no change. No findings.
- **Tickets filed.** None — nothing met the filing bar.
