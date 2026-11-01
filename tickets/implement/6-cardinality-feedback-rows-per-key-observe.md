description: Count how many rows each equality lookup through a non-unique index returns while queries run, and remember a per-table running average per looked-up column set, so the planner can later replace its flat "one tenth of the table per key" guess with a measured number.
architecture: docs/progressive-optimizer.md#3-cardinality-feedback
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/vtab/index-descriptor.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md, docs/usage.md
difficulty: hard
----

# Cardinality feedback: observe and record rows per key

First half of the rows-per-key slice (the planning context is in the companion ticket `cardinality-feedback-rows-per-key`, which consumes what this ticket records). This ticket adds nothing to planning: after it lands, plans are unchanged and the overlay merely holds per-key averages that `cardinality_feedback_keys()` can show.

## The gap

Without `ANALYZE`, an equality seek on a non-unique index is estimated at 10% of the table per key by both shipped modules (`EQ_SELECTIVITY_WITHOUT_STATS` in `vtab/memory/module.ts`, `ARM_SELECTIVITY.eq` in the store). On a foreign-key index that is off by orders of magnitude. Index seeks that queries already execute yield the real number for free: a single-key equality seek that runs to exhaustion returned exactly the rows matching one key value of its column set.

## What is observed

At the scan leaf (`emitSeqScan`, `runtime/emit/scan.ts`), decided once at emit time like `observesWholeTable` / `observesLowerBound`:

A site is a **rows-per-key site** when all of these hold:

- the plan is an `IndexSeekNode`, no `filterInfoOverride`;
- `accessPathPlan(filterInfo.accessPath) === 'eqSeek'` (one key tuple; `multiSeek` is excluded) and `accessPath.kind === 'index'` (an `unresolvedIndex` cannot say whether it is unique — decline);
- every `filterInfo.constraints[i].constraint.op` is `IndexConstraintOp.EQ`, and `limit` / `offset` are undefined;
- the index is not a unique key over the seek columns: skip when `accessPath.index.unique` and the equality column set covers every `accessPath.index.keyColumns` index (a whole-primary-key seek, a unique index seek — at most one row by proof, nothing to learn).

Put the eligibility test and the column-set derivation in one exported helper next to `accessPathPlan` (`vtab/index-descriptor.ts`) or in `vtab/filter-info.ts`: `equalitySeekKeyColumns(filterInfo): readonly number[] | undefined` — the sorted, de-duplicated base-column indexes of the EQ constraints, or `undefined` when the site does not qualify. The companion ticket's `IndexSeekNode` reads the same helper so the two cannot drift on what "a single-key equality seek" means.

Per eligible invocation, the emitter has a precomputed spec `{ columns, key: columns.join(','), plannedRowsPerKey: Number(plan.filterInfo.indexInfoOutput.estimatedRows) }` (built once in the emitter closure, no per-invocation string). When the invocation ends by **natural exhaustion** (`completed && !threw && !signal.aborted`) and **no seek argument is NULL** (`effectiveFilterInfo.args` — `col = NULL` matches nothing and would drag the mean toward zero; one short loop over one or two args on eligible sites only), call `observations.observeRowsPerKey(schema, spec, rowsYielded)`. An early-terminated invocation (a semi-join's first match, a `LIMIT`, `get()`) skips this but still reports its floor through `observeAtLeast` as today. A zero-row exhaustion with non-NULL keys is a real sample (a parent with no children) and counts.

Collation: a `COARSER_SAFE` seek over-fetches and a residual `Filter` above trims; the count taken here is what the seek yields — rows per key under the index's comparison — which is what the seek node relays and what the join candidate's rows-per-seek means. Say so in a comment at the site.

## The sink

`CardinalityObservations` gains `Map<TableSchema, Map<string, { spec, sum, count }>>`: one invocation is one sample; a nested-loop inner probing 10,000 outer rows contributes 10,000 samples to one key in one execution, aggregated here as sum and count and published once. `isEmpty` accounts for it; `rowsPerKey()` iterates `[table, spec, sum, count]`. Forked parallel branches share the sink by reference already (`shared-sink` policy in `parallel-driver.ts`) — nothing to add, but note it.

## The overlay entry

Inside the existing per-table `ObservedEntry` (`core/database-cardinality-feedback.ts`), add `perKey: Map<string, PerKeyEntry>` keyed by the spec key, with:

```ts
interface PerKeyEntry {
	readonly columns: readonly number[]; // sorted base-column indexes
	mean: number;        // rows per key, running average
	samples: number;     // samples folded into `mean` so far
	baseline: number;    // the estimate planning used before the first record (the module's), or the mean at the last shift
	shifts: number;      // stays 0 in this ticket; the companion ticket adds shift detection
}
```

**Record policy** (`recordRowsPerKey(table, spec, sum, count)`):

- ignore when the schema object is superseded (`isSuperseded`), as for counts;
- **table-size gate**: record only when `plannedBefore(table, existing) > cardinalityFeedback.minRows` — the planned size as of now (overlay entry, module count, catalog, else the 1000 default). Below that every plan finishes fast, and this keeps the SQL logic corpus (≤ 200-row tables) and the plan goldens unchanged, exactly as the count gate does. Consequence, stated in the doc: a table whose size is unknown learns rows per key only after its size is learned (a complete scan, or a floor above 1000 rows). Apply per-key records **after** the same execution's counts and floors, so a scan in the same execution opens the gate;
- an entry may exist with `rows` and `atLeast` both undefined (created by a per-key record via `newEntry`); `plannedRowCount` already treats that as no answer. `upsert` counts the observation and refreshes LRU recency as today;
- **smoothing**: with `n` = `samples` before and `k` = `count` in the batch, `batchMean = sum / count`, `mean += (batchMean − mean) × min(1, k / min(n + k, ROWS_PER_KEY_WINDOW))`, `samples += k`, `ROWS_PER_KEY_WINDOW = 32` (a module constant, not a tuning knob). First record sets the mean outright; up to 32 samples it is the exact running mean; past that each sample weighs 1/32, so drift is tracked; a batch larger than the window replaces the mean. Accepted bias (decided in planning): frequently probed keys weigh more than a uniform sample would — one mean per column set is the same uniform assumption `ANALYZE` statistics make;
- a new per-key entry's `baseline` is `spec.plannedRowsPerKey` (the module's estimate for that seek, which is what the plan used); `shifts` stays 0 here;
- **bounded**: at most `cardinalityFeedback.maxKeySetsPerTable` (new tuning knob, default 4) per table, least recently recorded evicted — `Map` insertion order, re-insert on record, like the table LRU. Table eviction drops the per-key map with the entry; a schema swap evicts the entry as today.

**Publication** (§3.5): per-key sums ride with the held observations — `HeldObservation` gains the same per-key map, `holdAll` accumulates sum and count across executions of one transaction, `onCommitted` applies them except for tables the transaction wrote, any rollback discards them, and the sink's rollback stamp covers them. `clear()` (option off, close) drops them with the entries.

## Diagnostics

A second table-valued function, `cardinality_feedback_keys()` (non-deterministic, same registration pattern as `cardinalityFeedbackFunc`): one row per valid per-key entry, ordered by schema, table, then key columns. Columns: `schema_name` TEXT, `table_name` TEXT, `key_columns` TEXT (column names in index order of the sorted indexes, comma-separated), `rows_per_key` REAL, `samples` INTEGER, `baseline_rows_per_key` REAL, `shifts` INTEGER. Key `(schema_name, table_name, key_columns)`. `snapshot()` exposes the per-key entries by value (`ObservedRowCountSnapshot.perKey`). Document in `docs/functions.md` beside the existing function's table, and add one sentence to the `cardinality_feedback` option row in `docs/usage.md`.

## Docs

`docs/progressive-optimizer.md`: §3.1 gains the third observation kind (site eligibility, exhaustion and NULL-key rules, collation note); §3.2 the per-key entry and its bound; §3.4 the record policy (table-size gate, smoothing, baseline); §3.5 one sentence that per-key sums are held and discarded like floors; §3.9 the new function; §6 no new files. Keep §5's "Rows per key" item until the companion ticket lands and say in it that observation is in and consumption follows.

## Edge cases & interactions

- Primary-key point seek: `index.unique` with full key coverage — not a site (helper, by inspection; covered by the existing "records nothing for a primary-key point seek" test, which must keep passing with the per-key map empty).
- Prefix equality seek on a composite unique index (a seek on fewer columns than the unique key): eligible, as the prefix is not unique — helper covers the full-key test, by inspection.
- `multiSeek` (`IN` list) and `prefixRangeSeek`: not sites — helper, by inspection.
- Correlated seek keys evaluating to NULL for some outer rows: skipped per invocation, by the arg check — one assertion in the observation spec (an outer row with a NULL join value contributes no sample).
- Isolation overlay merging uncommitted rows into a seek's output: covered by the transaction hold rule — by inspection, no new test.
- Eviction while held: a transaction holds per-key sums for a table whose entry is evicted before commit — `recordHeld` simply records afresh (new entry, gate re-applied) — by inspection.
- Sink shared by forked branches: sum/count updates are synchronous map writes, no interleaving hazard — by inspection.
- `cardinality_feedback = false`: no sink is created, `clear()` drops per-key entries — covered by the existing "records nothing with the option off" test plus one expectation on `cardinality_feedback_keys()` returning no rows.
- Overhead: per eligible invocation two map lookups and two additions in the sink, plus the arg NULL loop; nothing per row. Measure with `yarn bench --filter correlated` and `--filter join` before and after (foreground, no redirection); record the numbers in the review handoff and §3.8.

## Tests (each pins a branch of the policy)

- `test/runtime/cardinality-observations.spec.ts`: over `big` (20,000 rows, index on `v` with 4 rows per value), `select * from big where v = 7` records `rows_per_key = 4`, `samples = 1`; a `limit 2` over the same seek records no per-key sample; a seek where the key is NULL records nothing.
- `test/optimizer/cardinality-feedback.spec.ts` (record policy, through the manager directly): the table-size gate (a table planned at the 1000 default records no per-key entry; after `record(table, 20_000)` it does), the smoothing arithmetic across batches (two batches `(sum 40, count 10)` then `(sum 8, count 1)` give mean `(4·10 + 8)/11`; a batch of 100 samples after 32 replaces the mean), and eviction past `maxKeySetsPerTable`.

## TODO

- Add `equalitySeekKeyColumns` helper and the emit-time spec; wire `observeRowsPerKey` into the scan `finally` under the exhaustion and NULL-key rules.
- Extend `CardinalityObservations` with the per-key map and iterator; extend `isEmpty`.
- Add `PerKeyEntry`, `recordRowsPerKey`, the hold/commit/rollback plumbing, `maxKeySetsPerTable` tuning, and the snapshot shape.
- Add `cardinality_feedback_keys()` and register it; document in `docs/functions.md` and `docs/usage.md`.
- Update `docs/progressive-optimizer.md` §3.1, §3.2, §3.4, §3.5, §3.9.
- Write the tests above; run `yarn workspace @quereus/quereus lint` and the quereus suite; bench the two filters and report.
