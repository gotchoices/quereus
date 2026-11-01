description: When a query reads only part of a table — stopping after a LIMIT, or reading one range of an index — the rows it did read now prove the table holds at least that many; the planner remembers that floor so a table already shown to be large is no longer planned as small or of unknown size.
prereq: feat-planner-asks-the-backend-how-big-a-table-is
architecture: docs/progressive-optimizer.md#31-what-is-observed
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md
----

# Cardinality feedback: lower bounds from partial reads — review handoff

## What landed

Cardinality feedback used to learn a table's size only from a scan that read the whole table. Now a scan invocation that walks **one window** of a table (a full scan, or one index `scan` / `eqSeek` / `rangeSeek` / `prefixRangeSeek`, primary or secondary, partial index included) and either finishes, or is closed early by its consumer (`LIMIT`, `get()`, `EXISTS`), records "this table holds at least N rows", where N is the rows it yielded. The overlay keeps that floor and uses it to raise the planned row count.

- **Scan leaf** (`runtime/emit/scan.ts`): a new emit-time predicate `walksOneWindow` (over `accessPathPlan`) sits beside `enumeratesWholeTable`. Sites emitted with a `FilterInfoOverride` observe nothing, as before. The recording moved from after the loop into `finally`, behind `completed` / `threw` locals. A whole-table site that completes records an exact count; any other case records a floor. A site that threw, or whose signal is aborted when it ends, records nothing. The per-row loop has not changed.
- **Sink** (`runtime/cardinality-observations.ts`): `observeAtLeast` keeps the largest single invocation per table (not a sum). It takes the overlay's `minRows` at construction and drops any floor at or below it before touching its map. `lowerBounds()` skips tables this execution also counted exactly, so the exact count supersedes.
- **Overlay** (`core/database-cardinality-feedback.ts`): entries are now `{ rows?, atLeast?, baselineRows, observations, shifts }`. `recordAtLeast` records only when `b > before` and `b > minRows`, as `atLeast = max(atLeast, b)`. It shifts like a count, through the shared `shiftIfMoved`. `record` (exact) clears `atLeast`. Held observations are now `{ table, rows?, atLeast? }` per table; anything held under an older schema object for the same name is replaced wholesale. At commit, publication or a held apply, the exact count is recorded before the floor. `record` was decomposed into `isSuperseded`, `plannedBefore`, `upsert` and `shiftIfMoved`, which both record paths share.
- **Seam** (`planner/stats/table-cardinality.ts`): `ObservedRowCounts.observedRows` now returns an `ObservedRowCount` (`{ rows?, atLeast? }`), and it is the entry object itself, so nothing is allocated. `plannedRowCount` returns `max(atLeast, observed rows ?? approximate module ?? catalog)`, or `atLeast` alone when nothing else answers. An exact module count is never raised.
- **Diagnostics**: `cardinality_feedback()` has a new nullable `lower_bound_rows` column after `observed_rows`, and `observed_rows` is now nullable. `observations` counts both kinds.
- **Docs**: `docs/progressive-optimizer.md` §1 (principle wording), §3 intro, §3.1 (rewritten for two kinds), §3.2, §3.3, §3.4 (floor policy plus worked example), §3.5, §3.7 (new "Stale floor" bullet), §3.8 (cost and measurement), §3.9, §5 (item removed), §6. `docs/functions.md` column table.

## Tests

Added:
- `test/runtime/cardinality-observations.spec.ts` › "records the rows a LIMIT let through as a floor, not a count": `select * from big limit 5000` over the 20,000-row never-analyzed fixture gives `atLeast ≥ 5000` and no exact `rows`.
- same file › "records the rows a secondary-index range seek yielded as a floor": with an index on `v`, `where v between 1 and 6000` gives `atLeast = 6000`. An exact 6000 rules out a full scan with a residual filter (that path would record exact 20,000).
- `test/optimizer/cardinality-feedback.spec.ts` › record policy › "records a floor only above the current estimate, raising it until an exact count clears it": on a constructed manager it checks that a floor at the default is ignored, a floor raises an unknown table (seen through `CatalogStatsProvider.tableRows` over `databaseRowCountSources`), a smaller floor is ignored, an exact count supersedes (even a lower one), a floor equal to the count is ignored, and a 40× floor shifts and raises above the exact count. A final snapshot deep-equal closes the test.

Adjusted: the existing policy tests now read `observedRows(t)?.rows`, since the interface returns an object now. The first policy test's snapshot gained `atLeast: undefined`.

Unchanged and still passing, as the ticket required: "records nothing when a LIMIT stops the scan early" (`limit 10` stays under the floor), the point-seek test, the transaction tests, and `fork-contract.spec.ts`.

## Validation run

- `yarn lint` in `packages/quereus`: clean. `yarn docs:check`: OK. Its word-cap warnings are for other docs.
- `yarn test`: all workspaces pass (quereus 10,846 passing, 0 failing).
- `yarn test:store`: 10,838 passing, 0 failing.
- Bench: `yarn bench --filter full-scan | join | correlated`. The "before" run used the HEAD build of the five changed src files and the "after" run used this change, in the same tree, each compared with `--baseline`. Every row is inside its noise floor and every work-counter set is identical. `full-scan-10k` read +9.1% inside a ±25.1% floor (unstable) on the first after-run and −3.8% on a re-run. The numbers are recorded in §3.8. The result files were deleted afterwards.

## Judgment calls for the reviewer

- **What counts as "abort".** The `finally` check reads `runtimeCtx.signal?.aborted` as well as `threw`. An abort noticed downstream closes the scan with `return()`, not a throw, and without this read that case would record a floor. A *non-abort* downstream error that closes the scan with `return()` still records a floor. The rows were genuinely read, and exact counts from completed scans in an execution that later fails are published the same way. I read the ticket's "invocations ending in an error" as the scan's own error.
- **`unresolvedIndex` access paths qualify** for floors, because `accessPathPlan` answers for both index kinds and the property that matters is the shape (one window), not the index's identity.
- **Interface shape.** I changed `observedRows` to return the entry object, rather than adding a second `observedLowerBound` method. The alternative would mean two lookups and two recency touches per planner read. Callers get a readonly view.
- **`observations` counts floors too.** If the reviewer prefers it to count only exact counts, the TVF doc line changes with it.

## Known gaps

- There is no end-to-end test that a recorded floor changes a *compiled plan*. The precedence is pinned at `tableRows`, and the existing "an observed size reaches the plan" test covers the node-construction reader of the same seam.
- The transaction rules for floors (held, dropped when the table was written, discarded on rollback), nested-loop max-not-sum, multi-seek exclusion, and module-exact tables are checked by inspection only. They use the same code paths as counts, and the ticket asked for no new tests there.
- A floor at a module-exact table can still occupy an LRU slot when the table shrank between the read and publication. `plannedRowCount` never reads it. This is covered by the existing NOTE on `record` about module-sized tables.
