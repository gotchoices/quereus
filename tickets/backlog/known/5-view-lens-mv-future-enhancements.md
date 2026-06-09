---
description: Roadmap of further view-update / lens / materialized-view enhancements identified in the capability review (2026-06). Each item is a future concern, not active work; several already have their own complete/known tickets or doc-flagged limitations noted inline. Promote individual items into plan/ when ready.
---

## Context

These came out of a comparison of Quereus's view-update + lens + MV capability against other systems (PostgreSQL rules/INSTEAD-OF, Oracle/SQL Server indexed views, DB2 MQTs, BIRDS, Links relational lenses, Materialize/DBSP, Denodo, Dataphor). The three highest-leverage items were promoted to `plan/`:

- `view-write-through-shape-gaps` (outer-join / composite / n-way / self-join write-through)
- `lens-roundtrip-deploy-time-proving` (computed GetPut/PutGet over the view-complement)
- `mv-automatic-query-rewrite` (answer-from-MV optimizer rewrite)

The remainder are collected below.

## Items

### Richer incremental MV bodies — bounded-delta arms for floor-covered shapes (perf, not coverage)
Row-time MV maintenance now has **total coverage** — no body is rejected for its shape. Partial-`WHERE` 1:1 joins are a *bounded-delta* arm (`mv-join-where-widening`); **outer** 1:1 joins, set operations, recursive CTEs, scalar (no-`GROUP BY`) aggregates, >2-source joins, and *keyed* fanning joins all CREATE and are maintained by the always-correct **full-rebuild floor** (`mv-eligibility-floor-fallthrough`). A *key-dropping* fanning join is the one shape still **rejected** — as a bag (no provable unique key, `join-fanning-isset-overclaim`), not a shape reject; lifting that needs bag/multiplicity materialization (below), not a new arm.

What remains here is **performance, not coverage**: give the floor-covered shapes their own *bounded-delta* arm so a write applies a delta instead of a wholesale rebuild — a delta-arithmetic aggregate arm (`sum`/`count`, rescan-on-retraction for `min`/`max`), a null-extending reverse residual for outer joins, and a by-prefix fanning-join arm (the next consumer of the prefix-delete machinery). The doc-flagged direction (`docs/materialized-views.md` § Current limitations) is a **unified maintenance substrate** folding the row-time arms and the post-commit `DeltaExecutor` binding kernel under one `MaintenancePlan` abstraction with a backward (maintenance-direction) cost gate (both convergence points have since landed). DBSP/Materialize-style generality (incl. eventual semi-naïve recursion) is the borrow target. Existing per-shape tickets: `materialized-view-incremental-join-bodies`, `-set-ops`, `-recursive-cte`, `-tvf-sources` (complete/known).

### Update propagation through aggregation (delta-based)
`set sum = …` is ambiguous, but **delta-style group updates** ("apply this delta to the group") are well-defined and would be unique among SQL engines. Reserved in `docs/view-updateability.md` § Aggregation; the natural consumer is the incremental-maintenance / `DeltaExecutor` machinery.

### Federated multi-module write transactions
The basis can span modules, and a lens insert fans out across them — implying distributed-commit semantics (2PC or saga) when decomposition members live in different storage modules. Needs design before a genuinely cross-module decomposition deploy. Relates to the federated/VTab-centric design (`docs/architecture.md`) and the sync stack.

### Auxiliary-access recognizers for vector / full-text / time-series
The `AccessForm` registry (`src/planner/rules/access/lens-access-form-matcher.ts`) is explicitly open (`knn` / `contains` / `intersects` + open forms). Shipping a vector-similarity or full-text recognizer demonstrates the extensibility with zero engine change (the doc predicts exactly this) and rides a strong market wave. See `docs/lens.md` § Auxiliary-access read-path routing and its Current-limitations refinements (lossy/refinement forms, surrogate-keyed routing, `lens.no-answering-structure` crediting).

### Mechanical put-from-get auto-derivation (Voigtländer north-star)
Already the committed direction once the operator set stabilizes (`docs/view-updateability.md` § North-star). Keep the "no backward rule auto-derivation could not reproduce" invariant rigid so it stays a refactor, not a rewrite. Gated behind the in-flight operator-set work (general bodies, lateral-TVF, multi-source decomposition).

### Smaller, concrete gaps (each doc-flagged)
- **Non-integer surrogate generators** (`uuid7`, `nanoid`, `callback`) and **composite shared keys** — insert fan-out currently mints only an `integer-auto` single-column key.
- **MV-over-MV write-through** — DML against an MV whose source is itself an MV (route one level down to the inner MV's write-through); rejected today.
- **Concurrent refresh** — overlapping refreshes / refresh-while-read beyond the current atomic base-layer swap.
- **Per-logical-key conflict-action honoring** through a row-time covering MV whose basis UC does not itself carry the action — needs a planner→memory/isolation/store per-statement per-constraint conflict-override channel. Today rejected at deploy (the sound floor) via `lens.unenforceable-conflict-action`.
- **Non-binary covering-MV prefix scan** — thread per-column collation into `ScanPlan.equalityPrefix` matching so non-binary covering MVs use the prefix scan instead of the full-scan fallback.
- **GC of detached prior basis storage** — a logical removal detaches the mapping and retains the basis column; reclamation is application-driven and out of scope today.

### Speculative / differentiating
- **Temporal / bitemporal lenses** — lenses over system-versioned / temporal tables (Quereus has temporal types and the `committed.*` pseudo-schema already).
- **Lens-over-lens composition** as an explicit construct (MV-over-MV cascade exists; logical lens composition does not).
- **Queryable provenance / lineage** — "which basis rows produced this logical row" as a surface; the FD / update-lineage machinery already knows the answer.
- **`with check option` ergonomic sugar** — auto-generate the equivalent `create assertion` from a view predicate (the model replaces WCO with assertions, but a one-liner sugar could aid adoption).
