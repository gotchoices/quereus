description: When a query reads only part of a table — stopping after a LIMIT, or reading one range of an index — the rows it did read still prove the table holds at least that many; remember that as a floor so later plans stop treating a table already shown to be large as small or of unknown size.
prereq: feat-planner-asks-the-backend-how-big-a-table-is
architecture: docs/progressive-optimizer.md#31-what-is-observed
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md
difficulty: medium
----

# Cardinality feedback: lower bounds from partial reads

## Why

Cardinality feedback learns a table's size only from a scan that enumerates the whole table to natural exhaustion (`docs/progressive-optimizer.md` §3.1). In the deployments it targets — storage behind a network, where full scans are what a good plan avoids — that rarely happens: plans read tables through seeks, ranges and `LIMIT`ed scans, and every one of those currently observes nothing. Yet a read that yielded N distinct rows of a table proves the table holds at least N. A floor is enough to fix the costly mistake: planning a table already shown to be large at the 1000-row default (or at an older, smaller snapshot).

## What counts as a lower-bound observation

A table-access invocation (`emitSeqScan`, `runtime/emit/scan.ts`) records "this table has at least `rowsYielded` rows" when:

- its access path walks **one window** — `fullScan`, or an index plan of kind `scan`, `eqSeek`, `rangeSeek` or `prefixRangeSeek` (`IndexPlanKind`, `vtab/index-descriptor.ts`), primary or secondary, partial index included, with or without pushed constraints: each table row appears at most once in such a walk, and any subset of the table's rows bounds its size from below (a hand-built `FilterInfo` with no `accessPath` never qualifies, as for exact counts);
- it was emitted without a `FilterInfoOverride` (the key-set semi join and `OrdinalSlice` stamp their shapes at run time; excluded for simplicity, the same rule exact counts use);
- and it ended either at natural exhaustion (for a site that does not qualify for an exact count — a site that does still records its exact count, unchanged) or by the consumer's early `return()` (a `LIMIT` above, `Statement.get()`, an `EXISTS` short-circuit).

Excluded: `multiSeek` and `multiRangeSeek` plans (an `IN` list or overlapping `OR` ranges can yield one row twice), and invocations ending in an error or an abort (symmetry with exact counts; the cheap rule). Re-scans — a nested-loop inner, a seek per outer row — bound by the largest single invocation, never by a sum.

Record it in the scan's `finally` behind two locals (`completed`, `threw`) so the per-row loop is untouched; the call must be trivially cheap and unable to throw. Feedback off costs nothing extra (the sink is `undefined`); feedback on costs one comparison per invocation: let the sink carry the overlay's record floor (`cardinalityFeedback.minRows`, captured when `beginObservations` creates it) and drop any bound at or below it before touching its map.

## How the overlay holds and uses a bound

- **Entry shape.** An overlay entry gains `atLeast?: number` beside its exact `rows`, which becomes optional (a table may be known only from below). Validity, eviction and the schema-change listener are unchanged.
- **Record policy** (`CardinalityFeedbackManager`): with `before` = what planning would use now (`plannedRowCount(…) ?? defaultRowEstimate`, as `feat-planner-asks-the-backend-how-big-a-table-is` defines it), a bound `b` is recorded only when `b > before` and `b > minRows` — so a bound never lowers anything, and one below the default never makes an unknown table look smaller than it is planned today. Recorded: `atLeast = max(atLeast, b)`.
- **Exact supersedes.** Recording an exact count clears `atLeast` — it is the newer, complete fact. Within one execution an exact count for a table supersedes any bound for it.
- **Shifts.** A bound shifts like a count: when `spread(b, baselineRows) >= shiftFactor`, reset the baseline to `b` and call `onShift` (dependent statements re-plan under the existing cooldown). Bounds only ever raise, so they cannot oscillate on their own; an exact count can still lower an entry afterwards, as today.
- **Precedence** (`plannedRowCount`): the bound raises whatever answers below an exact module count — `max(atLeast, overlay rows ?? approximate module count ?? catalog)`, and `atLeast` alone when nothing else answers (it already exceeded the default when recorded). An exact module count is never raised: it is current, and a bound describes committed state at some earlier moment, so it cannot legitimately exceed it.
- **Publication** follows §3.5 exactly: held inside a transaction, applied at commit except for tables the transaction wrote, discarded by any rollback (the sink's rollback stamp covers bounds too).
- **Diagnostics.** `cardinality_feedback()` gains a nullable `lower_bound_rows` column; `observed_rows` becomes nullable (bound-only entries). Update `docs/functions.md`.

## Edge cases & interactions

- **`LIMIT 10` over a 20,000-row never-analyzed table** records nothing (10 is below the default); the existing test "records nothing when a LIMIT stops the scan early" keeps passing. Verify: that test.
- **`LIMIT 5000`** records a bound of 5,000 and the next compile plans the table at ≥ 5,000. Verify: test below.
- **Range seek** yielding many rows records a bound; a primary-key point seek (≤ 1 row) never clears the floor. Verify: test below; the existing point-seek test.
- **Multi-seek** (`id in (…)`) records nothing. Verify: inspection of the emit-time eligibility (one predicate over `accessPathPlan`).
- **Nested-loop inner seeks** bound by their largest invocation. Verify: inspection.
- **Forked parallel branches** share the parent's sink (`shared-sink` fork policy); max is order-independent. Verify: inspection; `test/runtime/fork-contract.spec.ts` unchanged.
- **Transaction rules**: a bound taken inside a transaction that wrote the table is dropped at commit; a rollback discards held bounds. Verify: inspection (same code path as counts; no new test).
- **Exactly module-sized tables** (the store): `before` is the live count, which a committed bound cannot exceed, so nothing is recorded. Verify: inspection.
- **Stale floor.** A table that shrinks after a bound keeps the floor until an exact count or a schema change replaces it; the error is an over-estimate, the direction that favors seeks over scans. Verify: inspection; state it in §3.7.
- **Error and abort paths** record nothing and must not be perturbed by the bookkeeping (it sits in `finally`, after the loop). Verify: inspection; the existing abort/error tests.
- **Overhead.** Run `yarn bench --filter full-scan`, `--filter join` and `--filter correlated` (the nested-loop inner re-scan path, one bound check per invocation) before and after the change in the same tree (foreground, a minute or two each; no worktree A/B) and compare with `--baseline`; the scan-heavy rows must stay inside their noise floor (§3.8).

## Tests (only these)

- `test/runtime/cardinality-observations.spec.ts`: (a) `select * from big limit 5000` records a lower bound of at least 5,000 (whatever the scan yielded before the limit closed it) and no exact count; (b) a secondary-index range seek returning 5,000+ rows (`… where v between 1 and 6000` over an index on `v`) records a bound. Same fixture (20,000-row `big`, never analyzed; add the index for (b)).
- `test/optimizer/cardinality-feedback.spec.ts`, record policy: one test walking the bound rules on a constructed manager — ignored at or below `before`; raises an unknown table above the default; `tableRows()` reports the raised value; an exact count clears it; a 10× bound shifts.

## TODO

- Sink: bounds map with the record floor; `observeAtLeast`; exact supersedes within an execution.
- `scan.ts`: emit-time eligibility (one-window plans, no override); `finally`-side recording on early return; bound at completion for non-whole-table sites.
- Overlay: `atLeast`, record policy, exact clears, shift on bounds, held/applied/discarded with transactions, `snapshot()`.
- `plannedRowCount`: raise by the bound per the precedence above.
- `cardinality_feedback()` column.
- The tests above.
- Docs: `docs/progressive-optimizer.md` §3.1 (partial reads now observe a floor), §3.2 (entry shape), §3.3, §3.4 (bound policy), §3.5 (bounds follow the same rules), §3.7 (stale floor), §3.8 (overhead), §3.9 (TVF), §5 (remove the "Lower bounds" item); `docs/functions.md`.
- `yarn lint`, `yarn test`, `yarn test:store`, the bench comparison above, `yarn docs:check`.
