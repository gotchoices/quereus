description: Foundation for automatic MV query rewrite — recognizing when a covering materialized view subsumes an *unnamed* scan-projection-filter query and rewriting it to scan the MV's backing table with a residual projection/filter. Delivers the matcher module, the rewrite rule + pass placement, the candidate/cost gates, query_plan visibility, self-maintenance suppression, and the equivalence harness the aggregate-rollup (3.1) and join-subsumption (3.2) phases extend.
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

- **Matcher** (`planner/analysis/query-rewrite-matcher.ts`) — pure analysis sibling to `coverage-prover.ts`; reuses `recognizeConjunctiveClauses` / `guardClausesEntail` so NULL semantics are identical. Containment: `P_q ⟹ P_mv`; residual = the `P_q` conjuncts not entailed by `P_mv`. Soundness contract: a false NotMatch only forgoes a speedup; every check forgoes on doubt.
- **Rule** (`rules/cache/rule-materialized-view-rewrite.ts`) — registered FIRST in the Structural `rewrite` pass (pass rules fire in registration order), so it sees the pristine fragment before pushdown/access-selection. Logical→logical, `sideEffectMode: 'safe'`, with a heuristic cost gate (strictly-cheaper, lowercased-name tiebreak).
- **Self-maintenance suppression** — `SchemaManager.withSuppressedMaterializedViewRewrite[Async]`, wrapped at the six sites that plan an MV's own body to (re)compute/maintain its backing.

## Review findings

Reviewed the implement-stage diff (`7d77033e`) with fresh eyes before reading the handoff: the matcher, the rule (incl. node construction / column remapping), pass placement + the pass framework's firing order, the schema-manager suppression, the helper/db-mv suppression sites, all three new specs, the two adapted specs, and both doc additions. Ran an additional probe spec for shapes the suite doesn't cover.

### Soundness (the load-bearing dimension) — checked, no issues

- **Entailment direction.** Verified `guardClausesEntail(a, b)` means `a ⟹ b` (read `partial-unique-extraction.ts:217`). The matcher's two uses are correct: containment `guardClausesEntail(queryClauses, mvClauses)` = `P_q ⟹ P_mv` (matcher.ts:268), and residual-drop `guardClausesEntail(mvClauses, conjunctClauses)` = "drop a conjunct already implied by `P_mv`" (matcher.ts:263). A conjunct only partially implied is kept whole (sound, just less optimal).
- **Multiplicity.** Backing = `π(σ_Pmv(T))` with no DISTINCT; the residual re-selects `σ_Pq` within it and the project re-emits, so row multiplicities match the base recompute. Projecting fewer columns never dedups (ProjectNode has no DISTINCT).
- **Column remapping.** `ColumnReferenceNode.columnIndex` is the base-table column index (Retrieve passes all base columns through in order); `backingColOfBaseCol` maps base→backing for both residual conjuncts and outputs. `outputColumnMap.length == fragAttrs.length` (every output must map or `missing-column`), so `buildReplacement`'s `fragAttrs[i]` indexing is aligned. Constructor arg orders for `ColumnReferenceNode` / `ProjectNode` verified against `reference.ts` / `project-node.ts`.
- **Pass-order argument.** Confirmed the pass framework (`pass.ts:520`) iterates `pass.rules` in push order and the rule is pushed first among `Project` rules; top-down traversal fires rules on the parent `Project` before any child Filter is pushed down — so the matcher always reads the pristine WHERE. The separate priority-ordered `registry.ts` path is not the execution path the optimizer uses.

### Edge cases (probe spec, then discarded) — all row-identical enabled vs disabled

- **Aliased / qualified-column source** (`from sales s where s.amt > 0`): rewrites and stays correct. The handoff flagged this as "handled by design but untested" — **added a permanent end-to-end regression test** for it (`query-rewrite.spec.ts`, "an aliased/qualified-column query rewrites and stays row-identical").
- **Duplicate output column** (`select amt, amt …`), **multi-conjunct residual** (`amt>0 and customer_id=7 and amt<15`), **self-referential `insert … select … where`**, and an **OR-body MV** (correctly declines — conservative NotMatch) all produce identical rows on vs off.

### Other dimensions

- **Type safety / DRY / modularity:** matcher is pure and decomposed into small single-purpose helpers; rule cleanly separates match / cost / node-build. No `any`. Consistent with `coverage-prover.ts` conventions.
- **Resource cleanup:** suppression uses try/finally depth counters (sync + async); `collectBodyRows` finalizes its statement inside the suppressed async scope.
- **Docs:** `docs/materialized-views.md` and `docs/optimizer.md` additions read accurately against the code (shape rules, gates, cost gate, pass placement, suppression). No staleness found.

### Disposition

- **Minor — fixed inline:** added the aliased-source end-to-end regression test (closes the one documented test gap).
- **Minor — observed, not changed:** `priority: 6` on the rule is dead in the pass path (push order governs), but it is consistent with every other pass rule setting an (ignored) `priority`, so changing it would be noise. The async suppression counter is SchemaManager-global; a concurrent unrelated optimize interleaving with a suppressed async body-recompute `await` could *miss* a rewrite (never produce a wrong one) — soundness-preserving, acceptable.
- **Major — none.** No new fix/plan/backlog tickets filed. The known gaps the handoff enumerated (heuristic non-stats cost gate; conjunctive-only predicate recognition; six suppression sites vs one choke point; no MV-over-MV transitive collapse; computed-output re-derivation out of scope) are all **missed-optimization / scope** items, not correctness defects — they do not gate this phase and are correctly deferred. The downstream 3.1 (aggregate rollup) and 3.2 (join subsumption) tickets extend this matcher and carry their own `prereq` chain.

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (incl. the added test).
- Full suite (`yarn workspace @quereus/quereus run test`) — **4626 passing**, 9 pending, 0 failing.
