description: Automatically rewrite a query to read from a covering materialized view the query did not name, when the MV provably answers it — the Oracle/SQL Server "query rewrite" / indexed-view-matching feature, built on the existing coverage prover.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/planner/building/select.ts, docs/materialized-views.md, docs/optimizer.md
----

## Why

Today a materialized view is consulted in two ways only: it answers **constraint enforcement** (the covering-structure path), and it answers **reads resolved by name** (a reference to `mv` resolves to its backing `TableReference`). What is missing is the mature-RDBMS feature: the optimizer recognizing that an *arbitrary* query — one that never names the MV — can be **answered from** a covering MV instead of recomputing its body against the base tables.

`docs/materialized-views.md` promises an MV is "observably indistinguishable from the plain view it derives from, only faster." Full transparency means the speedup applies even when the user writes the underlying query directly. This is the largest optimizer payoff on the MV roadmap and reuses the FD / coverage-prover surface already built for enforcement.

## What it must do

A rule (registered in `planner/framework/registry.ts`, `sideEffectMode: 'safe'`) that, given a query fragment and the set of non-stale MVs, recognizes when an MV's stored relation **subsumes** the fragment and rewrites the fragment to scan the MV's backing table (plus a residual projection/filter/aggregate when the MV is more general than the query):

- **Aggregate rollup** — a `group by g1,…,gk agg(...)` query answered by an MV grouped on a subset/superset key (a superset-key MV re-aggregates; an exact-key MV scans directly). The canonical Oracle query-rewrite case.
- **Projection/filter subsumption** — a scan-projection-filter query whose row set ⊆ the MV's materialized row set (predicate entailment, reusing the partial-UNIQUE / coverage-prover entailment vocabulary already in `coverage-prover.ts`).
- **Join subsumption** — a query whose join is covered by a 1:1-join MV body (reuse `proveOneToOneJoin`).

Soundness gates mirror the coverage prover: every check forgoes the rewrite on doubt (a false *NotMatch* only forgoes a speedup; a false *Match* is a correctness bug — wrong results). Staleness, partial-predicate alignment, NULL-skip, and determinism are all already-solved sub-problems on the enforcement path; reuse them.

The rewrite is **cost-gated** (`planner/cost/index.ts`): choose the MV scan only when cheaper than recomputing the body (it nearly always is for an aggregate, but a tiny base table or a highly selective predicate may not warrant it). When more than one MV matches, resolve deterministically (by cost, then a stable tiebreak).

## Expected behaviour / use cases

```sql
create materialized view daily as
  select d, sum(amt) total from sales group by d;

-- the user never names `daily`, but the optimizer answers from it:
select d, sum(amt) from sales group by d where d >= '2026-01-01';   -- → scan daily, residual filter
select sum(amt) from sales;                                          -- → re-aggregate over daily
```

- The rewrite is **non-regressing by construction**: the pre-existing path (recompute over base) is correct; the rule only ever *replaces* it with a provably-equivalent cheaper plan, and is a no-op when no MV matches or the cost gate declines.
- Result equivalence is the hard invariant — a rewritten query returns byte-identical rows to the unrewritten one, including NULL handling and empty groups.
- `query_plan()` shows the MV-backed scan so the rewrite is inspectable.

## Relationship to existing work

- This is the **read-side** dual of the covering-structure enforcement path (`covering-mv-enforcement-*`, `covering-structure-mv-rowtime-enforcement`, both complete). It consumes the same coverage prover and MV catalog; it does not touch the write/maintenance path.
- Distinct from `rule-materialization-advisory` (which decides whether to *materialize a CTE/subquery in-flight*) — this matches against *persisted* MVs. They may share matching helpers.

## Tests (TDD seeds)

- Equivalence property: over a corpus of MV bodies + random base seeds, assert `rewritten(query) == unrewritten(query)` for every matching query shape (the same oracle style as the maintenance-equivalence harness).
- Golden plans (`test/plan/`): a query that should rewrite shows the MV backing-table scan; a near-miss (stale MV, non-entailed predicate, partial-key mismatch) shows the base recompute (no rewrite).
- Negative: a stale MV is never used for rewrite; a non-deterministic-body MV is never used; an empty-group / NULL-group query returns identical rows rewritten vs not.
