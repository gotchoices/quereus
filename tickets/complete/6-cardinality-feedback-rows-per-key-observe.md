description: Count how many rows each equality lookup through a non-unique index returns while queries run, and remember a per-table running average per looked-up column set, so the planner can later replace its flat "one tenth of the table per key" guess with a measured number.
architecture: docs/progressive-optimizer.md#3-cardinality-feedback
files: packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/core/database.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/functions.md, docs/usage.md, docs/optimizer.md
difficulty: hard
----

# Cardinality feedback: observe and record rows per key — complete

Landed in `ticket(implement): cardinality-feedback-rows-per-key-observe`; reviewed and completed here. Plans are unchanged by this slice: the scan leaf counts the rows an exhausted single-key equality seek through a non-unique index yields, the per-execution sink sums those samples per table and column set, and the overlay (`CardinalityFeedbackManager`) folds each batch into a per-table, per-column-set running mean behind the same table-size gate and transaction rules the counts and floors already follow. `cardinality_feedback_keys()` shows what is held. The companion ticket `cardinality-feedback-rows-per-key` (implement stage) makes planning read the mean and adds shift detection.

## What landed (summary of the implement handoff)

- `equalitySeekKeyColumns(filterInfo)` in `vtab/filter-info.ts` is the one definition of an eligible seek: resolved index, plan `eqSeek`, every constraint `EQ`, no pushed limit or offset, and the equality set not covering every key column of a unique index. The companion's planner reader must use the same helper.
- The scan leaf builds a per-site `RowsPerKeySpec` once at emit time and, in its `finally`, records one sample for an invocation that ended by natural exhaustion with no NULL seek argument.
- The sink (`runtime/cardinality-observations.ts`) sums samples per table and column-set key; the overlay records a batch only when the table is already planned above `minRows`, smooths with an exact running mean up to 32 samples then a 1/32 weight per sample, keeps at most `cardinalityFeedback.maxKeySetsPerTable` (default 4) sets per table with least-recently-recorded eviction, and applies per-key batches after counts and floors so a scan in the same execution or transaction opens the gate for the seeks beside it.
- Held observations inside a transaction accumulate per-key sums and counts across executions and follow the commit, rollback, written-table and `clear()` rules exactly as floors do.
- Docs: `progressive-optimizer.md` §3 (3.1, 3.2, 3.4, 3.5, 3.8, 3.9, 5, 6), `functions.md`, `usage.md`, and the `cardinality_feedback` option description.

## Review findings

**Read first:** the implement commit's full source, test and docs diff, then the current `scan.ts`, `database-cardinality-feedback.ts`, `filter-info.ts`, `index-descriptor.ts` (descriptor `unique` resolution), `rule-select-access-path.ts` (how `FilterInfo.constraints` is populated) and `table-cardinality.ts` (`plannedRowCount` over an entry holding only per-key data).

**Checked, correct, no change:**

- Eligibility. `FilterInfo.constraints` holds only the constraints the seek consumed (declined ones are re-applied as a `Filter` above and never appear there), so the recorded column set is exactly the seek's equality set. The primary-key descriptor is built with `unique: true` and secondary descriptors carry the schema's flag, so a whole-primary-key or unique-index seek is excluded as the docs say; a unique-index prefix qualifies.
- Scan leaf. The rows-per-key test is a strict subset of the lower-bound test (an `eqSeek` walks one window), so the `observesAnything` OR and the explicit `else if (observesLowerBound)` guard preserve the previous floor behaviour exactly. A seek with a `FilterInfo` override, a thrown error, an abort, or an early `return()` records no sample. The NULL rule reads the effective (dynamic) seek arguments, which is what a correlated or parameterised seek ran with.
- Overlay. The smoothing weight `min(1, count / min(n + count, 32))` gives the exact running mean below the window, 1/32 per sample past it, and replacement by a window-sized batch; the arithmetic test pins all three regimes. An entry created by a per-key record alone has neither `rows` nor `atLeast`, and `plannedRowCount` falls through to the module, catalog or default for it. Deleting from a `Map` while iterating its keys (per-key and table eviction) is well defined. `upsert` runs before the per-key mutation, so the table being recorded is most recent and cannot be the one evicted.
- Transactions. Held per-key batches ride the same `HeldObservation` as the count and floor, so a committing transaction that wrote the table drops them with the rest, and any rollback or the sink's rollback stamp discards them.
- Diagnostics. `cardinality_feedback_keys()` orders by code-unit compare like its sibling and advertises a key on the first three columns, which the per-table column-set map makes unique.
- Resource cleanup, error handling and type safety: nothing new is allocated per row; the per-invocation cost is one `includes` over one or two seek arguments and two map lookups; no exceptions are swallowed; `estimatedRows` is a `bigint` converted once at emit time.

**Found and fixed in this pass (minor):**

- The existing test "records nothing for a primary-key point seek" passed for the wrong reason: `big` had never been sized, so the table-size gate would have dropped any sample regardless of eligibility. The helper's exclusion branches were therefore unpinned. Added one test to `test/runtime/cardinality-observations.spec.ts` that learns the size first, then runs a whole-primary-key seek and an `IN`-list seek and asserts no rows-per-key sample. Both statements were confirmed (via `query_plan()`) to plan as `IndexSeek` nodes, so the test reaches the helper, not the gate.
- `docs/optimizer.md` still summarised cardinality feedback as table sizes only, in its topic table and its Philosophy paragraph; both now name rows per key as the third observation kind.

**Tests cut:** none. Each implement-stage test pins a stated rule (eligibility, exhaustion, NULL keys, holding, gate and baseline, smoothing regimes, eviction) rather than restating the implementation.

**Considered and declined (no ticket, no tripwire):**

- Held per-key samples keep the first execution's `plannedRowsPerKey` as the batch's baseline when several statements in one transaction seek the same column set with plans priced at different table sizes. Both numbers are the module's estimate for the same seek; they differ only by the spread in planned table size between two compiles inside one transaction, and the baseline only feeds the companion's shift rule. Not worth a note at the site.
- `maxKeySetsPerTable: 0` would evict the set just recorded. It is a tuning value no deployment sets to zero and the result is merely "remembers nothing"; the existing `maxTables` knob has the same shape and no guard.

**Tripwires recorded:** none new. The existing `NOTE:` on `walksOneWindow` (multi-valued indexes) covers the rows-per-key site too, since an eligible site is a lower-bound site.

**Tickets filed:** none. No finding reached the filing bar.

**Pre-existing failures:** none observed.

## Validation

- `yarn workspace @quereus/quereus lint` clean after the test edit (eslint plus the test type pass).
- `yarn test` in `packages/quereus`: 10857 passing, 25 pending, 0 failing (log in `tickets/.logs/6-cardinality-feedback-rows-per-key-observe.review.test.log`).
- The implement stage's benchmark numbers (`yarn bench --filter correlated` and `--filter join`, all rows inside their noise floors, work counters identical) are recorded in `docs/progressive-optimizer.md` §3.8; not re-run here since this pass changed no runtime code.

## Handoff to the companion

- `IndexSeekNode` must price through `equalitySeekKeyColumns` so what is priced is exactly what is observed.
- The planner should read the mean through a manager method (`observedRowsPerKey(table, columns)`), not the snapshot, which carries column names for diagnostics.
- The baseline a new column-set entry carries is the module's `estimatedRows` of the recorded seek's plan, so a seek planned at the 1000-row default carries 100, one planned after the size is learned carries 10% of that size.
