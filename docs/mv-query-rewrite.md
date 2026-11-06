# Query resolution

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

How a query reads a [materialized view](materialized-views.md): a reference that names the view reads its stored rows through the ordinary table path, and the optimizer's automatic read-side rewrite answers a query that never names the view from a covering one — by projection + filter subsumption, aggregate rollup, or join subsumption — gated on function identity. A satellite of [Materialized Views](materialized-views.md).

A reference to `mv` in a query resolves through the **ordinary table path** — the table *is* the materialization, so the reference is a plain `TableReferenceNode` against it, not a body expansion. Reads therefore go straight to the stored rows and cost like a table scan, not like re-running the body. The one derivation-specific step is the build-time [`stale`](mv-schema-change.md#schema-change-staleness) re-validation guard, which still runs on a derivation-bearing table reference. (An unqualified MV reference resolves against the current schema; a materialized view in a non-current schema must be qualified.)

## Automatic query rewrite (read side)

The above is the *named* read path. There is also an **automatic** path: the optimizer recognizes when an *arbitrary* scan-projection-filter query — one that **never names** the MV — is *answered from* a covering MV, and rewrites it to scan the maintained table itself with a residual projection/filter instead of recomputing the body against the base tables (a plan shows a scan of `mv`, the table's own name). This is the read-side dual of the [coverage prover](mv-constraints.md#explicit-covering-structures-the-coverage-prover) (which proves a base-table `UNIQUE` constraint is covered, on the write/enforcement side).

```sql
create materialized view recent as
  select id, customer_id, amt from sales where amt > 0;

-- never names `recent`, but the optimizer answers from it:
select customer_id, amt from sales where amt > 0 and customer_id = 7;
--   → scan recent, residual filter (customer_id = 7), residual project (customer_id, amt)
```

The matcher (`planner/analysis/query-rewrite-matcher.ts`) asks **output-relation subsumption**: does the MV's stored rows contain a superset of the rows the fragment produces, keyed so a bounded residual recovers exactly the fragment's output? It reuses the coverage prover's entailment vocabulary (`recognizeConjunctiveClauses` / `guardClausesEntail`), so NULL semantics are identical. Soundness mirrors the prover exactly — **a false NotMatch only forgoes a speedup; a false Match would return wrong rows** — so every check forgoes the rewrite on doubt. The rule (`planner/rules/cache/rule-materialized-view-rewrite.ts`) only ever *replaces* the correct recompute-over-base plan with a provably row-equivalent backing scan, so it is non-regressing (a no-op when nothing matches or the cost gate declines, byte-identical rows when it fires). See [docs/optimizer-rule-families.md](optimizer-rule-families.md#materialized-view-query-rewrite-read-side) for the matcher shape rules, the gates (stale / deterministic / source-schema), the cost gate, and pass placement.

The matcher handles three shapes: **projection + filter subsumption** (above), **aggregate rollup**, and **join subsumption** (both below). The rewrite is **suppressed while planning an MV's own body** to (re)compute or maintain its backing (create / refresh / row-time-maintenance compile), so a body matching a registered MV is never re-pointed at the backing it is populating (`SchemaManager.withSuppressedMaterializedViewRewrite`).

### Aggregate rollup (indexed-view matching)

The headline case: a `group by g₁,…,gₖ agg(…)` query answered from a **grouped** MV. The matcher (`matchAggregateFragmentToMv`) fires when the fragment root is a logical `Aggregate(Filter?(scan(T)))` and the MV body is `select g…, agg(…) … group by g…` over the same single source `T`. The query GROUP BY and MV GROUP BY are mapped to **bare source-column** sets (a computed group key on either side ⇒ forgo); the query key must be a **subset** of the MV key (⊄ ⇒ NotMatch). Two sub-cases:

```sql
create materialized view daily as
  select d, sum(amt) as total, count(*) as cnt from sales group by d;

select d, sum(amt) from sales group by d;   -- exact-key  → scan daily, residual project (no re-aggregation)
select sum(amt) from sales;                  -- rollup     → scan daily, re-aggregate sum(total) into one group
```

- **Exact-key** — query key == MV key. The backing rows *are* the answer: scan the backing directly with an optional residual `Filter` on the group-key columns (a range `where g ≥ …`) and a residual `Project`. No re-aggregation, so any query aggregate that is *exactly* a stored MV aggregate (same function, argument, and `distinct`) is admitted as a passthrough — including `count(distinct)` / `group_concat`. `avg` under exact-key requires a stored `avg`.
- **Superset-key (rollup)** — query key ⊊ MV key (incl. the empty global key, the degenerate "re-aggregate every backing row into one group" case). The backing partials are **re-aggregated** down to the query's coarser key. Soundness is decided by each fragment aggregate's **declared [`AggregateAlgebra`](aggregate-algebra.md)** (`recipeForRollup`) — *not* a builtin-name list — so a built-in aggregate and a UDAF that declares the same algebra roll up through the one code path (default-deny — an aggregate with no usable algebra ⇒ forgo). A DISTINCT aggregate always forgoes (a distinct aggregate is never a plain merge of partials):

  | fragment aggregate declares | recombine over the MV's stored partials |
  |---|---|
  | **directly mergeable** — `merge` + `decode` (`sum`, `count`, `min`, `max`, and any abelian-group UDAF) | re-aggregate the aggregate's **own** stored partial by folding each stored value through the aggregate's `merge ∘ decode`, then its `finalize`. `sum`←sum-of-sums, `count`←sum-of-counts, `min`/`max`←tightening. The empty-group value falls out of `finalize(identity)` (`count`→0, `sum`/`min`/`max`→NULL), so there is no name-specific `coalesce`. |
  | **decomposable** — `decompose` (`avg` ≡ `sum(x)/count(x)`) | re-aggregate each sibling partial (each itself directly-mergeable) and apply the declared `combine` over their finalized values. avg needs the MV to store both `sum(x)` **and** a count; the count must exclude the same NULLs `avg` does — a stored `count(x)` always qualifies, a stored `count(*)` only when `x` is declared `not null`. avg's NULL/0-over-zero-rows ⇒ NULL guard lives inside `combine`. |
  | **no usable algebra**, or any `distinct` | **forgo** — `total` / `group_concat` / `var_*` / `stddev_*` (residual-only, declare no algebra) and `count(distinct …)` (the classic rollup trap: a partial `count(distinct)` cannot be re-summed). |

**Function identity.** Both sub-cases trust a stored value only while its name still resolves to the **same registration that produced it**. Function registration overwrites by `(name, argument count)`, so `db.createAggregateFunction('sum', …)` re-points `sum/1` for every later query while the backing keeps the previous function's numbers. `registerMaterializedView` therefore records the schemas the body's calls resolved to (`TableDerivation.bodyFunctions`, runtime-only — object identity cannot be serialized) and the matcher compares the live resolution against that capture by identity; a mismatch, or no capture at all, ⇒ forgo (`function-rebound`). A view built over a UDAF that is still the live registration keeps matching.

The **maintenance** side reads the same capture, one registration later. So long as the plan compiled at registration keeps running, every backing row was produced by the functions that capture names — writes after a takeover are maintained with the *previous* semantics, which is what makes the backing internally consistent. But some operations **re-register** the view and so recompile that plan against whatever is registered at that moment (`alter table … rename` on the view, and the rename propagation's restore pass on a source rename). Switching maintenance to the new implementation there would leave the backing holding two functions' answers at once — the groups a later write touches computed the new way, every untouched group still the old way. `registerMaterializedView` therefore compares the prior capture against the freshly resolved one by identity (`detectBodyFunctionDrift`) and marks the view **stale** on any difference: the read-side rewrite already declines a stale view, row-time maintenance detaches (the backing stops changing rather than changing inconsistently), and `refresh materialized view` re-derives every row under the new meaning. See [Schema-change staleness § Body-function drift](mv-schema-change.md#body-function-drift).

One limit remains: object identity cannot cross a process boundary, so across a reopen the capture is re-taken from whatever is registered then — a *user* function's sameness across a reopen can be verified neither by the read-side gate nor by drift detection.

**Soundness witnesses.** The backing's primary key must equal the MV's group key (`backingPkIsGroupKey`) — the schema-level form of the coverage prover's `proveEffectiveKeyUnique`, certifying the backing is one row per MV group, so the exact-key scan returns one row per query group and the rollup re-aggregates a *set*, not a bag. A residual `Filter` may reference only MV group-key columns (it partitions whole groups, commuting with the rollup); a `where` on a non-group column ⇒ NotMatch (the MV already aggregated those rows away).

A **rollup with a residual** is sound and admitted: the residual references only MV group-key columns (per the soundness witnesses above), so it partitions whole backing groups and the rule builds a residual `Filter` on the backing scan *before* the re-aggregate, commuting with it. That shape — `group by k` re-aggregating a composite-PK backing under `where j = const` on a non-grouped key — is covered by the equivalence harness.

### Join subsumption

A query whose join is the **same 1:1 row-preserving inner/cross join** as an MV body's join (the row-time [`'join-residual'`](mv-maintenance.md#join-residual-11-innercross-join-shape) shape — eligibility shape 4) is answered from the maintained table, **eliminating the join at read time**.

```sql
create materialized view enriched as
  select o.id, o.customer_id, o.amt, c.name
  from orders o join customers c on o.customer_id = c.id;   -- 1:1 (NOT-NULL FK → PK)

select o.id, o.amt, c.name
from orders o join customers c on o.customer_id = c.id
where o.amt > 100;                                          -- → scan enriched, residual filter + project
```

The hard soundness question — "does this join contribute *exactly one* row per governed `T` row?" — is the coverage prover's shared `proveOneToOneJoin` (no-row-loss descent + `proveJoinNoFanout`). A 1:1 join's output relation is in bijection with `T`'s governed rows, so two 1:1 joins over the *same tables, same equi-pairs, same join type* produce the same row set. The matcher (`matchJoinFragmentToMv`) therefore:

- **proves both joins 1:1 over the same `(T, lookup)`** — runs `proveOneToOneJoin` on *both* the fragment join and the MV body join (the rule plans the MV body once, suppressed, and caches its optimized root). It requires the **same driving table `T`**, the **same lookup table**, an **inner/cross** top join on each side (outer is deferred — its null-extended rows make the stored relation differ from an inner-join query), and **equi-pair equivalence** in `(driving-col, lookup-col)` terms (a mismatch — e.g. a join on a *second* FK to the same lookup — ⇒ NotMatch, the soundness-critical guard);
- **proves projection coverage** over the joined output — every fragment output column (including lookup-side columns) must be a bare passthrough the MV stores, mapped through stable attribute ids;
- **carries the post-join WHERE as a residual**. A join MV body has **no WHERE** (the row-time create gate rejects a partial join body), so predicate entailment is trivial: the whole fragment WHERE becomes the residual `Filter` over the backing. **Read-side relaxation:** a WHERE term on a *lookup-side* column is allowed here (unlike the row-time arm's partial-WHERE restriction) — we are only *reading* the already-materialized join, so the residual filters the stored joined rows directly. The residual re-binds onto the backing by **source attribute id** (a base-column index is ambiguous across a join), and every residual column must be a stored backing column.

The replacement is the foundation's emission unchanged — backing scan → residual `Filter` → residual `Project` — because once both joins are proven equal the joined output relations are equal. The cost gate's recompute estimate now includes both base scans **plus the join cost**, so the backing scan wins decisively; cheapest-wins with the same stable-name tiebreak.

**Out of scope (deferred):** outer-join 1:1 bodies (the row-time arm defers them too); multi-join MV bodies covering a sub-join of the query (partial join matching); rollup over a join MV.
