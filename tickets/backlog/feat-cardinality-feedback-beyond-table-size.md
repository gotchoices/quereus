description: Once the planner learns real table sizes from running queries, the next step is learning how many rows each filter and join actually keeps — which is what most plan choices really hinge on, but is much harder to remember reliably from one plan to the next.
prereq: cardinality-feedback-replan
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/conjunct-selectivity.ts, packages/quereus/src/planner/util/column-origins.ts, packages/quereus/src/planner/analysis/expression-fingerprint.ts, packages/quereus/src/vtab/best-access-plan.ts, docs/progressive-optimizer.md, docs/optimizer-costing.md
tradeoffs: Selectivity depends on the parameter values and on correlations the observation cannot see, so a remembered fraction can be confidently wrong for the next binding; and predicates pushed into a storage module are estimated by the module itself, so using observed fractions means a new module-facing contract or the engine and module disagreeing about the same rows.
----

# Feedback for predicate selectivity and join output

## Where this starts from

The `cardinality-feedback-*` chain (see `docs/progressive-optimizer.md` §3) teaches the planner one fact from execution: the exact size of a table some query read in full. That fixes the "every un-analyzed table is 1000 rows" problem, but most plan choices hinge on a different number — how many of those rows a predicate keeps, and how many rows a join produces. Today those come from catalog column statistics when `ANALYZE` ran, and from flat guesses (`NaiveStatsProvider`: 0.1 for any comparison, 0.3 default) when it did not. A table nobody can afford to analyze — the remote/DHT case this design targets — never gets better than the guesses.

## What to learn

- **Single-table predicate selectivity:** for a `Filter` directly over one base table's rows, input rows vs output rows; for a seek or constrained scan, rows returned vs the table's (observed or catalog) size.
- **Join output cardinality:** rows out of a join vs the product of its inputs, for an equi-join between two base relations.

Candidate observation sites are the operators that already touch every row (filter output, hash-join build, scan/seek output). The old design's table of "free" instrumentation points (sort input, hash-join build side, hash-aggregate input and group count, filter output, scan output) is the menu; sort and aggregate input counts are intermediate cardinalities whose meaning depends entirely on the plan around them, and are probably not worth keying.

## Problems a design has to settle

- **A key that survives re-planning.** `fingerprintExpression` (`planner/analysis/expression-fingerprint.ts`) cannot be reused as is: it keys columns by attribute id (fresh on every build), embeds literal values, and falls back to node ids for subqueries. A usable key needs base-table columns resolved by origin (`collectColumnOrigins`, as `conjunct-selectivity.ts` already does for estimation) plus a normalization of literals and parameters to placeholders — and a decision about which literal values stay in the key.
- **Parameter sensitivity.** `status = ?` keeps 90% of rows for one value and 0.1% for another. One remembered fraction per key averages them (pg_stat-style); per-value memory is unbounded; neither is obviously right. Decide, and decide how a plan built for one binding treats the next.
- **Pushed-down predicates.** A predicate a module accepts is estimated by the module (`getBestAccessPlan` → `rows`), from `tableInfo.statistics` — and `docs/optimizer-costing.md` makes it a rule that the module's `rows` equals what the engine's provider would say for the same predicate. Observed fractions break that unless the module can see them: extend `BestAccessPlanRequest` with observed selectivities, or have modules consult the overlay through the same provider surface.
- **Smoothing and staleness.** One observation can be an outlier; data drifts. Running average, decay, or last-value; and when an entry expires.
- **Interaction with column statistics.** When both exist, which wins and when (the table-size overlay's rule — newest exact count wins, a fresh `ANALYZE` voids observations — does not transfer directly, because a fraction observed for one binding is not exact for another).
- **Correlation.** An observed combined selectivity for `a = 1 and b = 2` captures the correlation that `feat-multi-column-correlation-stats` wants to collect by `ANALYZE`; decide whether this subsumes it for observed predicate shapes.

## Who benefits

The work parked elsewhere that the old adaptive-optimizer ticket tied to feedback: `or-to-union-rewriting` (whether N index seeks plus de-duplication beats one scan is a selectivity question), `aggregate-pushdown` (pushing aggregation below a join pays only when the join barely reduces rows), `covering-indexes` (index-only access vs fetch overhead) — all in `tickets/backlog/known/`.
