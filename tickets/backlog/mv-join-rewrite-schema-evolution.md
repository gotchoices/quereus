description: Re-enable the join-subsumption MV read-rewrite for a `select *` (schema-shifting) join MV body after a source `alter table` + `refresh`. Today such an MV correctly *forgoes* the rewrite (falling back to base recompute) because its backing columns no longer align positionally with the re-planned body output; this restores the optimization without sacrificing the soundness guard.
files: packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/src/core/database-materialized-views.ts
----

## Background

The join-subsumption arm of `ruleMaterializedViewRewrite` keys each backing column by
the MV body's **output position** (`mvStoredJoinColumns`). That mapping is sound only
while the backing columns correspond positionally — count and name — to the body
output, the invariant established when the backing is built column-for-column from the
body.

A source `alter table <source> add column …` (or drop) followed by `refresh
materialized view` **desynchronizes** a `select *` join MV body from its backing:

- the re-planned `select *` body **interleaves** the new source column at the source's
  natural position (e.g. `orders.extra` lands between `orders.*` and `customers.*`);
- the refreshed backing does **not** reorder to match (the new column appends, or the
  backing schema is otherwise not rebuilt in body order).

The review of `mv-query-rewrite-join-subsumption` found this previously produced **wrong
rows or a planning crash** (out-of-range backing column). That review added a soundness
guard — `backingAlignsWithBody` in `query-rewrite-matcher.ts` — that verifies positional
name alignment and **forgoes** the rewrite (`no-candidate`) on any mismatch, so the
result is now always correct (base recompute). Explicit-column join MV bodies are
unaffected (their output column set is stable across a source column add/drop).

## Use case

A user defines `create materialized view v as select * from a join b on …`, later runs
`alter table a add column …; refresh materialized view v`, and expects join-eliminating
reads from `v` to resume — as they already do for an explicit-column join MV and for a
single-source `select *` MV (whose appended column stays positionally aligned).

## Desired behavior

After a source ALTER + refresh, a `select *` (or any schema-shifting) join MV body
should once again serve the read-side join rewrite, with the same row-equivalence
guarantee. Candidate directions (pick during design):

- Rebuild the backing **in body order** on refresh, so position alignment is restored
  (and the existing positional map just works); or
- Give the matcher a **provenance-based** body-output → backing-column map (match by a
  stable backing-column identity rather than position), removing the positional
  assumption entirely — this would also harden the foundation and aggregate arms.

## Out of scope

The soundness guard must remain: any chosen fix must still forgo (never mis-read) when
it cannot prove the body→backing column correspondence.
