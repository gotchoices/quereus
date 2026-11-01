description: Count how many rows each equality lookup through a non-unique index returns while queries run, and remember a per-table running average per looked-up column set, so the planner can later replace its flat "one tenth of the table per key" guess with a measured number.
architecture: docs/progressive-optimizer.md#3-cardinality-feedback
files: packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/core/database.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md, docs/usage.md
difficulty: hard
----

# Cardinality feedback: observe and record rows per key — implemented, for review

First half of the rows-per-key slice. Nothing in planning changes: plans are identical before and after (every plan golden and the whole quereus suite pass unchanged), and the overlay now holds per-table, per-column-set running averages that `cardinality_feedback_keys()` shows. The companion ticket `cardinality-feedback-rows-per-key` (implement stage, `prereq:` on this slug) consumes them.

## What landed

- **Eligibility helper** `equalitySeekKeyColumns(filterInfo)` in `vtab/filter-info.ts` (not `index-descriptor.ts`: `filter-info` already imports `index-descriptor`, the other way round would be a cycle). Returns the sorted, de-duplicated base-column indexes of a single-key equality seek through a non-unique index, else `undefined`: resolved index, plan `eqSeek`, every constraint `EQ`, no `limit` / `offset`, and the set does not cover every key column of a unique index. The companion ticket's `IndexSeekNode` must read this same helper.
- **Scan leaf** (`runtime/emit/scan.ts`): a per-site `RowsPerKeySpec` `{ columns, key, plannedRowsPerKey }` built once at emit time (`rowsPerKeySpecOf`); in the `finally`, an invocation that ended by natural exhaustion with no NULL seek argument calls `observeRowsPerKey`. The floor path is now gated on `observesLowerBound` explicitly (it was the `else` of the whole-table test) so the rows-per-key gate and the floor gate cannot drift if `walksOneWindow` ever changes. Collation note is at the site.
- **Sink** (`runtime/cardinality-observations.ts`): `Map<TableSchema, Map<string, { spec, sum, count }>>`, `observeRowsPerKey`, `rowsPerKey()` iterator, `isEmpty` extended. Exports `RowsPerKeySpec` and `RowsPerKeySamples`.
- **Overlay** (`core/database-cardinality-feedback.ts`): `PerKeyEntry { columns, mean, samples, baseline, shifts }` in `ObservedEntry.perKey` (insertion order is recency, re-inserted on record, bounded by the new `cardinalityFeedback.maxKeySetsPerTable`, default 4); `recordRowsPerKey(table, spec, sum, count)` with the superseded-schema check, the table-size gate (`plannedBefore > minRows`), the smoothing `mean += (batchMean − mean) × min(1, k / min(n + k, 32))` (`foldRowsPerKey`, `ROWS_PER_KEY_WINDOW = 32` module constant), baseline = `spec.plannedRowsPerKey`, `shifts` stays 0. `upsert` counts the batch as one observation and refreshes the table's LRU slot. Per-key batches are applied after counts and floors in both `recordAll` and `recordHeld`. `HeldObservation.perKey` accumulates sums and counts across a transaction's executions; commit / rollback / `clear()` treat them like floors. `snapshot()` exposes `perKey: ObservedRowsPerKeySnapshot[]` with column **names** (`keyColumns`), `rowsPerKey`, `samples`, `baselineRowsPerKey`, `shifts`. `isSuperseded` lost its `rows` parameter (the log line no longer needs it).
- **Diagnostics**: `cardinality_feedback_keys()` (`func/builtins/cardinality-feedback.ts`, registered beside `cardinality_feedback`): columns `schema_name, table_name, key_columns, rows_per_key REAL, samples, baseline_rows_per_key REAL, shifts`, ordered by schema, table, key columns; key on the first three.
- **Docs**: `progressive-optimizer.md` §3 opening, §3.1 (third kind, eligibility, exhaustion and NULL rules, collation), §3.2 (entry and bound), §3.4 (record policy), §3.5 (held like floors, applied after counts), §3.8 (overhead numbers), §3.9 (the function), §5 (observation in, consumption follows), §6 (helper and knob). `functions.md` (table row, columns section, `observations` column now counts batches). `usage.md` (one sentence on the option row). The `cardinality_feedback` option description in `database.ts` mentions rows per key.

## Behaviour worth knowing when reviewing

- **Baseline is whatever the recorded seek's plan used.** A seek planned while its table still plans at the 1000-row default carries `plannedRowsPerKey = 100` (10% of 1000); one planned after the size is learned carries 10% of that size (2000 for a 20,000-row table). The transaction test pins the first case: the full scan and the seeks were in one transaction, the count was held, so the seeks were priced at the default. For the companion's shift rule either baseline is far from a true 4 rows per key.
- **Table-size gate** means a one-shot seek over a never-scanned memory table records nothing until the size is learned (full scan, a floor above 1000, or a module count). The observation tests therefore do `create index`, then `select * from big` (the index swaps the schema, which would evict an entry recorded before it), then the seeks.
- **`observations`** on the table entry now also counts per-key batches, so `cardinality_feedback().observations` climbs by one per execution per sampled column set for seek-heavy tables.
- The `else if (observesLowerBound)` guard in the scan `finally` was added after the benchmark runs below; it is one branch per invocation, nothing per row, and I did not re-bench for it.

## Tests added (each beside what it pins)

`test/runtime/cardinality-observations.spec.ts` (`big` gained a third column `k` with four rows per value; three existing inserts now supply three values — columns are implicitly NOT NULL in this engine, so a column list was not an option):

- *records the rows an exhausted equality seek … as one rows-per-key sample* — the site qualifies, one sample of 4, baseline 2000, read through `cardinality_feedback_keys()` so the function's column mapping is covered too.
- *records no rows-per-key sample when a LIMIT stops the seek early* — the exhaustion rule.
- *records no rows-per-key sample for a seek whose key is NULL* — the NULL-argument rule through a bound parameter; a non-NULL binding of the same statement then records one sample.
- *holds rows-per-key samples made inside a transaction until it commits, behind the same count* — hold, per-key accumulation across executions (two seeks → `samples: 2`), and the count-before-keys order opening the gate at commit.
- The existing primary-key point-seek test also asserts an empty `perKey`; the option-off test also asserts `cardinality_feedback_keys()` returns no rows after a seek.

`test/optimizer/cardinality-feedback.spec.ts` (through the manager; two existing `snapshot()` deep-equals gained `perKey: []`):

- *records rows per key only for a table planned above minRows, with the planned rows per key as baseline* — the gate, the baseline, and the batch counting as one observation.
- *tracks the exact running mean up to 32 samples, then weighs each sample 1/32, and a window-sized batch replaces it* — the smoothing arithmetic at all three regimes (`(4·10 + 8)/11`, exact mean at exactly 32, one sample past the window at 1/32, a batch of 100 replacing).
- *evicts the least recently recorded column set past maxKeySetsPerTable* — the bound, and that a record refreshes recency.

## Validation

- `yarn workspace @quereus/quereus lint` clean (eslint plus the test type pass).
- `yarn test` in `packages/quereus`: 10856 passing, 25 pending, 0 failing (log in `tickets/.logs/6-cardinality-feedback-rows-per-key-observe.test.log`). A later rerun of the feedback specs after the last two edits is in the run output.
- Bench (`yarn bench --filter correlated` and `--filter join`, feedback on by default), rebuilt `dist/` against baselines taken minutes earlier on the old build in the same machine state: `correlated-subquery` −2.0% (±15.7% floor), `@store-mem` −2.3% (±12.3%); `join-1kx1k` +2.1% (±21.3%), `@store-mem` +3.9% (±18.9%); `join-plan` −1.9% (±6.0%); all work-counter sets identical. Recorded in §3.8.
- Bench caveat, also in §3.8: the bench imports the built `dist/`, so a bench right after an edit measures the old build until `yarn build` runs in the package; and a baseline taken before the 3-minute test suite read 22–35% slower when re-measured on the same old build right after it. The numbers above are the fair pair.

## Known gaps and things a reviewer might weigh

- No test exercises a correlated nested-loop seek (an index-nested-loop plan over a non-unique index) end to end; the NULL-key rule is pinned through a bound parameter instead. The planner does not choose such a plan without the companion ticket's pricing (that is the gap it closes), so an end-to-end sample through a join waits for it.
- `cardinality_feedback_keys()` ordering across several tables and key sets is by inspection only (code-unit compare, same as the sibling function).
- The `COARSER_SAFE` over-fetch is documented, not tested: the count is the seek's yield before the residual filter.
- `ObservedRowCountSnapshot.perKey` carries column names, not indexes; the companion's planner reader should go through the manager (an `observedRowsPerKey(table, columns)` method it adds), not the snapshot.
