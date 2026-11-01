description: Once the planner learns real table sizes and per-key lookup counts from running queries, the remaining step is learning how many rows filters on unindexed columns, range conditions and joins actually keep — what most plan choices hinge on, and much harder to remember reliably from one plan to the next.
prereq: cardinality-feedback-rows-per-key
files: packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/conjunct-selectivity.ts, packages/quereus/src/planner/util/column-origins.ts, packages/quereus/src/vtab/best-access-plan.ts, docs/progressive-optimizer.md, docs/optimizer-costing.md
tradeoffs: Selectivity depends on parameter values and on correlations an observation cannot see, so a remembered fraction can be confidently wrong for the next binding; filter and join observations must be keyed so they survive re-planning, and predicates pushed into a storage module are estimated by the module, so using observed fractions there means a new module-facing contract or the engine and module disagreeing about the same rows.
----

# Feedback for filter selectivity, ranges and join output

## Where this starts from (refreshed 2026-11-01)

Landed (`docs/progressive-optimizer.md` §3): the exact size of a base table read in full, module-reported table sizes, lower bounds from partial reads, and the first slice beyond table size — rows matched per key by executed equality seeks through non-unique indexes (`cardinality-feedback-rows-per-key-observe` records them; `cardinality-feedback-rows-per-key` makes planning read them and re-plans on a shift). All are recorded in a per-database overlay, and cached statements re-plan on a 10× shift of a count, a floor or a per-key mean. The rows-per-key slice settled three of the design questions below for equality seeks, and its decisions as implemented are the precedent for what remains:

- **Key**: the `TableSchema` object plus the sorted base-column set of the seek's equality constraints (`equalitySeekKeyColumns` in `vtab/filter-info.ts` is the one definition of an eligible seek, shared by the scan leaf and the planner) — no attribute ids, no literals, no node ids.
- **Parameter sensitivity**: one running mean per column set, whatever the key values — the uniform assumption `ANALYZE` statistics already make.
- **Pushed predicates**: the engine overrides only its own consumers of the estimate (`IndexSeekNode` relays the observed rows per key as its `estimatedRows`; the index-nested-loop candidate prices a seek from it) and leaves the module's cost, `rows` and access-path choice unchanged; catalog statistics covering the column set take precedence over the observation (`plannedRowsPerKey` in `planner/stats/table-cardinality.ts`), so a module reading them stays consistent with the engine.

Engine-side estimates over equality *filters* with no seek (a `Filter` above a scan) were left out of that slice and belong here.

## What remains

- **Equality filters on unindexed columns.** A `Filter` directly over a full scan of one base table, predicate a conjunction of `column = value` on base columns: input vs output rows give a fraction for that column set. Needs the filter's input to be the whole table (a qualifying scan below it) and a key from column origins (`collectColumnOrigins`, as `conjunct-selectivity.ts` does for estimation). Consumers: `CatalogStatsProvider` selectivity when no catalog statistics cover the columns — and the multi-relation statistics gate (`statsOnlySelectivity`) must decide whether an observed fraction counts as "real statistics".
- **Range selectivity.** `column > value` fractions depend on the value far more than equality does; one mean per column is not a usable estimate. Needs either value-bucketed memory (an observed histogram) or a decision that ranges stay on the naive estimate.
- **Join output cardinality.** Rows out of an equi-join between two base relations against the product of its inputs — keyed by the two tables and the joined column sets. Intermediate cardinalities whose meaning depends on the plan around them (sort input, aggregate input) stay out of scope (§3.1).
- **Correlation.** An observed combined fraction for `a = 1 and b = 2` captures the correlation `feat-multi-column-correlation-stats` wants `ANALYZE` to collect; decide whether observation subsumes it for observed predicate shapes.

## Problems a design still has to settle

- **Smoothing and staleness** for fractions: running mean, decay, or last value, and when an entry expires.
- **Interaction with column statistics**: when both exist, which wins (the table-size rule — newest exact count wins, a fresh `ANALYZE` voids observations — does not transfer to a fraction observed under some bindings and not others).
- **Overhead**: a filter-side observation adds a counter to a loop that already touches every row, but the eligibility test (is this filter directly over a whole-table scan, are its conjuncts base-column equalities) must be decided at emit time, never per row.

## Who benefits

The parked work the old adaptive-optimizer ticket tied to feedback: `or-to-union-rewriting` (whether N index seeks plus de-duplication beats one scan is a selectivity question), `aggregate-pushdown` (pushing aggregation below a join pays only when the join barely reduces rows), `covering-indexes` (index-only access against fetch overhead) — all in `tickets/backlog/known/`.
