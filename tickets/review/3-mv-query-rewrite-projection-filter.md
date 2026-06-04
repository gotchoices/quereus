description: Review the foundation for automatic MV query rewrite — recognizing when a covering materialized view subsumes an *unnamed* scan-projection-filter query and rewriting it to scan the MV's backing table with a residual projection/filter. Delivers the matcher module, the rewrite rule + pass placement, the candidate gates + cost gate, query_plan visibility, self-maintenance suppression, and the equivalence harness the aggregate-rollup (3.1) and join-subsumption (3.2) phases extend.
files: packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/query-rewrite.spec.ts, packages/quereus/test/query-rewrite-equivalence.spec.ts, packages/quereus/test/plan/materialized-view-rewrite-plan.spec.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/materialized-views.md, docs/optimizer.md
----

## What landed

The read-side dual of the covering-structure enforcement path. The optimizer now recognizes that an *arbitrary* `Project(Filter?(scan(TableReference)))` query — one that never names an MV — is **answered from** a covering MV, and rewrites it to scan the MV's backing table (`_mv_<name>`) with a residual projection/filter instead of recomputing the body against the base tables.

```sql
create materialized view recent as select id, customer_id, amt from sales where amt > 0;
-- never names `recent`, but the optimizer answers from it:
select customer_id, amt from sales where amt > 0 and customer_id = 7;
--   → scan _mv_recent, residual filter (customer_id = 7), residual project (customer_id, amt)
```

### Matcher (`planner/analysis/query-rewrite-matcher.ts`) — new, pure analysis

Sibling to `coverage-prover.ts`; reuses its entailment vocabulary (`recognizeConjunctiveClauses` / `guardClausesEntail` from `partial-unique-extraction.ts`) so NULL semantics are identical. Public surface: `analyzeQueryFragment(root)` (fragment shape walk → base table + bare-column outputs + WHERE conjuncts), `matchFragmentToMv(shape, mv, backing, isDeterministic)`, and the convenience `matchMaterializedViewRewrite(...)`. Soundness contract mirrors the prover: **a false NotMatch only forgoes a speedup; a false Match returns wrong rows**, so every check forgoes on doubt. Reasons: `no-candidate` (stale / non-deterministic / no backing), `source-mismatch`, `shape`, `predicate-not-entailed`, `missing-column`.

- **Fragment WHERE is read from the live plan** (`FilterNode.predicate.expression`), **the MV WHERE from `mv.selectAst.where`** — both recognized to guard-clauses over base `T`. Entailment is containment: `P_q ⟹ P_mv`; residual = the `P_q` conjuncts not entailed by `P_mv`.
- **Projection** maps via base-column index (`ColumnReferenceNode.columnIndex` for the fragment; the MV select-list resolved by name for the backing, `*` expanded to all base columns, computed items left unmapped).

### Rule (`rules/cache/rule-materialized-view-rewrite.ts`) — new

Registered **first** in the Structural `rewrite` pass (pass rules fire in *registration* order, not by `priority`), so it sees the pristine `Project(Filter?(Retrieve(TableReference)))` before grow-retrieve / predicate-pushdown reposition the Filter and before the Physical pass absorbs a predicate into a range scan. `sideEffectMode: 'safe'`. Logical→logical, so the substituted backing `TableReference` flows through normal physical access selection → `query_plan()` shows the `_mv_<name>` scan for free. The cost gate (`seqScanCost + filter + project`, base vs MV) chooses the MV only when strictly cheaper; cheapest wins, stable lowercased-name tiebreak. Builds the replacement re-emitting the fragment's **identical output attribute ids** (the parent splice depends on it), re-binding residual conjuncts onto the backing columns.

### Self-maintenance suppression (load-bearing)

`SchemaManager.withSuppressedMaterializedViewRewrite[Async]` + `isMaterializedViewRewriteSuppressed()` (mirrors the existing assertion-hoist suppression). The rule is suppressed wherever an MV's **own body** is planned to (re)compute or maintain its backing — otherwise the body would be recognized as "answered from" the MV and re-pointed at the very backing it is populating. Wrapped sites: `deriveBackingShape`, `collectBodyRows`, `revalidateBody`, `linkCoveredUniqueConstraints` (`materialized-view-helpers.ts`), `buildMaintenancePlan` + `compileResidual` (`database-materialized-views.ts`).

### Two existing tests updated to preserve intent (not the feature regressing)

- `covering-structure.spec.ts` `bodyRoot`: plans the MV body with the rewrite suppressed (the coverage prover analyzes the body over its **source**, exactly as the production `linkCoveredUniqueConstraints` now does).
- `maintenance-equivalence.spec.ts` `assertEquivalent`: the live-body oracle disables the rewrite for its source recompute — the body *is* the MV's defining SELECT, so without this the oracle would read the very backing it exists to check (vacuous green). The `select * from mv` side is unaffected (named read → backing directly).

## Use cases to validate (the acceptance gate)

`test/query-rewrite.spec.ts` — matcher driven directly (per-reason observable) + end-to-end:
- **Positive:** `P_q ⊇ P_mv` → match with the extra clause as residual; `P_q == P_mv` → empty residual; MV with no WHERE subsumes any WHERE (residual = full `P_q`); `select *` MV (star expansion); computed MV column ignored when the query needs only passthrough columns.
- **Per-reason negatives:** `predicate-not-entailed` (no-WHERE query vs WHERE MV); `missing-column` (fragment projects an omitted column; residual references an omitted column); `source-mismatch` (different base table).
- **Gates:** a **stale** MV and a **non-deterministic-body** MV are never matched.
- **End-to-end:** rewrites to the backing scan with identical rows (enabled == disabled); a near-miss keeps the base recompute; **MV self-maintenance is never rewritten** (create + row-time insert maintenance + refresh all read from source).

`test/plan/materialized-view-rewrite-plan.spec.ts` — golden plans: covering query shows `_mv_<name>`; near-miss / stale show the base recompute; **cost gate declines** a no-win case (no-WHERE MV answering a no-WHERE query); cheapest-wins **name tiebreak** across two identical MVs; backing scan flows through physical access selection.

`test/query-rewrite-equivalence.spec.ts` — the **soundness backstop**: over random base data (including NULLs and empty results), `rewritten(query) == unrewritten(query)` row-for-row for a corpus of covering and near-miss queries (rule enabled vs disabled), plus a non-vacuous check that the rewritable queries actually produce a backing scan. This is the harness 3.1 / 3.2 extend with their shapes.

## Validation performed

- `yarn workspace @quereus/quereus run build` / `typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full suite (`mocha "test/**/*.spec.ts"`) — **4624 passing**, 9 pending, 0 failing (was 4615 before this ticket's specs).

## Known gaps / where to scrutinize (honest — treat the tests as a floor)

- **The cost gate is heuristic, not stats-grounded.** Memory tables expose no row count to `StatsProvider.tableRows` (it returns 0 / the naive 1000 default), so the gate falls back to `DEFAULT_ROWS = 1000` and a fixed `MV_WHERE_SELECTIVITY = 0.5` discount: an MV that carries a WHERE is modeled as a row-reduction win, an MV with no WHERE answering a query is not. This fires/declines sensibly for the tested shapes, but it is **not** a principled cost model — a reviewer should decide whether real stats (ANALYZE / vtab-reported `rowCount`) should drive it, and whether a tiny *real* base should ever decline a filtered-MV rewrite (today it fires). Soundness does not depend on the gate; a wrong decision only changes which (still-correct) plan runs.
- **Predicate recognition is conjunctive-clause only.** A query/MV WHERE with any conjunct outside the shared guard-clause vocabulary (function-wrapped columns, subqueries, `LIKE`, …) makes recognition return `undefined` → conservative NotMatch, even when a sound rewrite exists (e.g. `… where amt > 0 and f(x) = 1` against `… where amt > 0`). This matches the coverage prover's discipline; widening the residual to carry unrecognized-but-extra conjuncts is a possible follow-up.
- **Fragment-WHERE read off `.expression` relies on the pristine-fragment firing point.** The matcher reads the fragment's WHERE from the live `FilterNode`'s originating AST. This is sound *because* the rule fires before pushdown/access-selection (documented at length in the matcher header, incl. the constant-folding divergence argument). The shape walk also rejects range-bounded scans / seeks defensively. If a future reordering moved the rule's firing point after predicate absorption, an absorbed predicate would be invisible and the guard is the range-bounded-scan rejection — worth a second look.
- **Self-maintenance suppression is wrapped at six call sites, not one choke point.** I enumerated every place that plans an MV body to (re)compute/maintain its backing. If a *new* MV-body-planning path is added later (e.g. a new maintenance arm) without the suppression wrapper, it could be re-pointed at the backing. The `maintenance-equivalence` suite (now non-vacuous) is the regression net; a reviewer may prefer a higher choke point.
- **MV-over-MV chains are not collapsed transitively.** The rule fires once per node (the rewritten node inherits the applied-rule set), so a query over `T` is not rewritten through `MV-A over T` *and then* `MV-B over MV-A`. Missed optimization, not incorrect.
- **Computed-output re-derivation is out of scope (3's parked item).** A fragment output that is a computed expression the MV does not already store ⇒ `missing-column`; v1 never re-derives it from stored backing inputs even when all inputs are present. The ticket flagged this as "file a backlog ticket if worth doing" — not filed; mentioned here for the reviewer's call.
- **Aliased-source / qualified-column queries** (`from sales s where s.amt > 0`) are handled by design (entailment resolves by bare name; remap by `columnIndex`) but are **not** directly tested — the specs use unqualified single-source queries. A reviewer may want an aliased positive case.
- The downstream **3.1 (aggregate rollup)** and **3.2 (join subsumption)** implement tickets extend this matcher; their `prereq` chain through this slug is preserved (same slug in `review/`).
