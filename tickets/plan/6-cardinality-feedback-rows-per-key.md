description: Teach the planner, from the index lookups queries already run, roughly how many rows one lookup key matches on each indexed column set — so a join through a non-unique index stops being priced from a flat "one tenth of the table per key" guess when nobody has collected statistics.
prereq: cardinality-feedback-lower-bounds, unknown-size-join-scans-instead-of-seeking
architecture: docs/progressive-optimizer.md#5-deferred-work
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/func/builtins/cardinality-feedback.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module-access-plan.ts, docs/progressive-optimizer.md, docs/optimizer-costing.md
difficulty: hard
----

# Cardinality feedback, first slice beyond table size: observed rows per key

The first slice of `feat-cardinality-feedback-beyond-table-size` (backlog — the rest of it stays there). Plan stage: confirm the recommended design below against the tree as it stands once the prerequisites have landed (the overlay entry shape changes in `cardinality-feedback-lower-bounds`, join selection's unknown defaults in `unknown-size-join-scans-instead-of-seeking`), size it, and emit implement tickets — probably two, observe-and-record then consume-and-re-plan.

## The gap

With no `ANALYZE`, an equality seek on a non-unique index is estimated from a module shape constant: 10% of the table per key, in both the memory module (`estimateEqualityRows`, `EQ_SELECTIVITY_WITHOUT_STATS`) and the store (`ARM_SELECTIVITY.eq`, deliberately the same number). That estimate is `rowsPerSeek` in the index-nested-loop cost and the row count `IndexSeekNode` relays to everything above it. On a typical foreign-key index it is off by orders of magnitude. Measured (memory backend, never analyzed, 2,000-row `parent`, 8,000-row `child` with an index on `parent_id`, four children per parent): `select p.name, c.note from parent p join child c on c.parent_id = p.id where p.name = 'p7'` plans a hash join over a full scan of `child` (5.9 ms) instead of seeking the index (1.24 ms after `analyze`), because 100 guessed rows per key price the seek plan at `100 × (1.5 + 0.3 × 100) = 3,150`. The fix for unknown table sizes does not reach this case; only a better rows-per-key does. In the remote deployments this targets, `ANALYZE` is the unaffordable operation, while index lookups are exactly what good plans execute — so they are the evidence to learn from. The limit is inherent: the slice learns only from seeks something has already executed (point lookups, correlated subqueries, other joins); a plan that never seeks an index teaches nothing about it.

## Recommended design

### What is observed

At a table-access invocation (`emitSeqScan`) whose plan is an `IndexSeekNode` with access plan `eqSeek` over **one** key tuple (not `multiSeek`), no `FilterInfoOverride`, and whose module-enforced constraints (`IndexSeekNode.pushedConstraints`) are all equalities on the seek columns — nothing else claimed, no limit or offset — an invocation that runs to natural exhaustion yields exactly the number of rows matching one key value of that column set. Record `(table, column set, rowsYielded)`. Early-terminated invocations (a semi-join's first match, a `LIMIT`) are skipped: a partial count of one key is not that key's count.

- **Key**: the `TableSchema` object plus the sorted base-column indexes of the equality set. Stable across re-plans (no attribute ids, no literal values, no node ids — the three reasons `fingerprintExpression` was rejected in `docs/progressive-optimizer.md` §4); valid while the schema object is current, exactly like the row-count entry (an index create or drop swaps the schema).
- **Value**: rows per key, as a running mean over samples with an exponential weight that adapts to drift (e.g. weight `1/min(n, 32)`), plus the sample count. One invocation is one sample; a nested-loop inner probing 10,000 outer rows contributes 10,000 samples to one key in one execution — aggregate per execution in the sink (sum and count per key), publish once.
- **Bounded**: a few column sets per table (oldest evicted), inside the existing per-table LRU.

### Parameter sensitivity — decided: one average per key

`status = ?` can match 90% of rows for one value and 0.1% for another. One mean per column set is the classic uniform-distribution assumption (`1 / distinct count`) that `ANALYZE` statistics already make; per-value memory is unbounded and per-binding plans do not exist (§3.7). Accepted bias: frequently probed keys weigh more than a uniform sample would. A plan built from the mean serves every binding, as plans built from `ANALYZE` do.

### Pushed-down predicates and the module rule — decided: the engine overrides the relay, modules unchanged

`docs/optimizer-costing.md` requires a module's `rows` for a predicate to equal what the engine's provider says for it. Feeding observed rows-per-key to modules would need a new module-facing contract and every module to adopt it; a module that did not would disagree with the engine. Instead the engine uses the observation where it consumes the estimate itself:

- `IndexSeekNode.computePhysical`, for a single-key `eqSeek` on an observed column set, relays the observed rows per key instead of the module's `rows` (snapshot at construction, like `TableReferenceNode`'s planned rows — the node reaches the overlay through its source's schema manager);
- the index-nested-loop candidate's `rowsPerSeek`, for the same key (the join key's column set).

The module's own cost and its arm choice stay in its currency, unchanged. State the override where module authors read the `rows` rule (`docs/optimizer-costing.md` § "Where a module's own SELECTIVITY fits"; `docs/module-authoring.md` is at its word cap). Engine-side estimates over equality *filters* (no seek) are not touched in this slice.

### Interaction with column statistics

When `ANALYZE` statistics cover the column set, they win — the observation answers only where the catalog cannot (no statistics, or a column set the catalog has no distinct count for). Reconsider after measuring; the row-count rule (newest exact count wins) does not transfer to an average.

### Re-planning

Reuse the shift machinery: when a key's mean moves `shiftFactor` from the value plans were built with (a per-key baseline), call `onShift` for the table so dependent statements re-plan under the existing cooldown. The 1000-row record floor has no direct analogue; gate on the effect instead — record only when `rowsPerKey × max(1, outer estimate)` could matter, or simply when the mean differs from the module's estimate by `shiftFactor` (decide in planning).

### Publication

§3.5 unchanged: held in a transaction, applied at commit except for tables the transaction wrote, discarded on any rollback.

## Edge cases & interactions (to carry into the implement tickets)

- A seek over a unique key (≤ 1 row per key by proof) needs no observation — skip it.
- Collation: a `COARSER_SAFE` seek over-fetches and a residual filter trims; count what the seek yields (rows per key of the index's comparison), and say so.
- The isolation overlay merges uncommitted rows into a seek's output — covered by the transaction rule.
- Forked parallel branches share the sink.
- Overhead: per eligible invocation, one sum-and-count update in the sink; measure with the execution suite's correlated-subquery and join rows (foreground, under 5 minutes, no worktree A/B).
- Diagnostics: `cardinality_feedback()` needs a way to show per-key entries (a second table-valued function, or a JSON column) — decide.
- Determinism: one more history-dependent input; `pragma cardinality_feedback = false` must disable it.

## TODO

- Re-read the overlay, sink and scan-site code as left by the prerequisites; confirm or amend each decision above.
- Decide the record gate, the smoothing constant and the diagnostics shape.
- Emit implement tickets (observe and record; consume and re-plan) — keep this slug on the last of them, since `feat-cardinality-feedback-beyond-table-size` names it as its prerequisite — each with tests that pay for themselves — at minimum the `parent`/`child` join above flipping to the seek plan after a handful of executed `child_parent` seeks (`select note from child where parent_id = ?` for a few keys), and the mean's shift re-planning a dependent statement.
- Update `feat-cardinality-feedback-beyond-table-size` (backlog) if the slice changes what remains; the last implement ticket removes the "Rows per key" item from `docs/progressive-optimizer.md` §5.
