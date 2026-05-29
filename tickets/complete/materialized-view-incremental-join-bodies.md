description: Accept multi-source inner/cross-join row-preserving bodies for `on-commit-incremental` materialized views. `MaterializedViewManager.compile()` synthesizes a per-source `'row'` binding (each on that source's PK); a change to any participating source maintains the MV — the source(s) whose PK cleanly covers the backing physical PK maintain incrementally, the rest fall back to full rebuild (the always-correct escape). Outer/semi/anti joins, aggregate-over-join, set-ops, and multi-source DISTINCT are rejected at create and deferred.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What shipped

The whole change lives in `MaterializedViewManager.compile()`
(`packages/quereus/src/core/database-materialized-views.ts`). The maintenance
pipeline below `compile()` (`key-filter.ts`, `delta-executor.ts`,
`join-node.ts`) is already per-relation and needed no change.

- **No source** → reject. **Aggregate path**: unchanged single-source logic,
  now guarded with a `size > 1` → reject (aggregate-over-join).
- **Row-preserving path** (no aggregate, 1..N sources): reject `SetOperation`
  (catches `union all`), `size > 1 && Distinct` (DISTINCT over a join),
  `size > 1 && hasNonInnerJoin` (outer/semi/anti); then bind every table ref on
  its own PK. For `size === 1` this reduces exactly to the prior single-source
  behavior.
- New helpers: `containsNodeType`, `hasNonInnerJoin` (duck-types `joinType` over
  logical `Join` + physical join variants; unreadable/non-inner ⇒ reject).

Docs (`docs/materialized-views.md` — eligibility + rejection list) updated to
match. Deferred work filed in backlog: `materialized-view-incremental-outer-joins`,
`-aggregate-join`, `-set-ops`, `-recursive-cte`, and
`-join-bodies-equivalence-provenance` (the both-clean true-incremental path) —
all five confirmed present.

## Review findings

### Scope of the review
Read the implement diff (`c0aecd8b`) with fresh eyes before the handoff: the
`compile()` restructure, the three new helpers, the §19–21 sqllogic additions,
and the docs diff. Traced the maintenance path (`apply` →
`computeDeleteKeyOrder` → `buildDeleteKey`/`runResidual`) and the optimizer pass
framework. Aspect sweep: correctness, SPP/DRY, type-safety, error handling,
resource cleanup, maintainability, performance.

### Correctness — verified sound
- **The incremental join path is safe by construction.**
  `computeDeleteKeyOrder` returns non-null only when a source's PK resolves (via
  attribute provenance) to a *superkey* of the backing physical PK, which
  guarantees a 1:1 source-row → backing-row(s-with-that-PK) mapping; the
  per-binding delete-then-recompute is then exact. Every other case (the
  fan-out/parent side of a 1:many, self-joins, both sides composite, many:many)
  resolves to `null` ⇒ full rebuild, which is always correct. Worked through the
  1:many / many:many cases explicitly; could not construct an incremental fire
  that yields a wrong delete.
- **Eligibility gate reads a stable plan.** Confirmed against
  `framework/pass.ts` + `registry-bootstrap.ts`: only `predicate-pushdown` and
  `cte-optimization` run at `PassId.Structural` (order 10); all join, aggregate,
  distinct-elimination, and gather-union-all rules run at `Physical`/
  `PostOptimization` (orders 20/30). So `optimizeForAnalysis` (up-to-Structural)
  preserves the logical `JoinNode` (exposing `.joinType` incl.
  `semi`/`anti`/`left`/`right`/`full`), the `SetOperationNode`, the
  `DistinctNode`, and the logical `AggregateNode` the gate depends on. The
  implementer's fragility note (a future *structural* lowering could break this)
  is accurate and worth an assertion if pass placement ever moves.
- **Create-time rejection confirmed.** `registerMaterializedView` → `compile()`
  runs inside the CREATE emitter (`emit/materialized-view.ts`), which rolls back
  the backing table on throw — so the `-- error:` assertions fire at create.
  Verified the sqllogic `-- error:` directive (logic.spec.ts:722) matches the
  *preceding* accumulated statement via case-insensitive substring on the thrown
  message, so §21/§22 directive placement (after the create) is correct.

### Minor — fixed inline (this pass)
- **Coverage gap closed.** The headline "inner/**cross**" claim and the
  multi-source DISTINCT rejection gate were both unexercised. Added **§22** to
  `52-materialized-views-incremental.sqllogic`: a CROSS join MV (composite
  backing PK ⇒ rebuild path; create-time cartesian product + a source-side
  update both asserted) and a `select distinct … from a join b` create that must
  fail with `DISTINCT over a join`. Both empirically confirmed before landing.

### Observations — no action needed
- **Semi/anti via `EXISTS`/`IN`.** Represented as `JoinNode` with `joinType`
  `'semi'`/`'anti'` ⇒ caught by `hasNonInnerJoin` when decorrelated. If not
  decorrelated at analysis, behavior matches the prior single-source world (the
  subquery table is simply not a tracked source) — not a regression, and the
  rebuild net keeps any accepted shape correct.
- **Per-source no-PK gate is unreachable** (DDL tables always get an all-columns
  PK) — left as defensive code mirroring the single-source rule. Acceptable.
- **Self-join / cascading-over-join / both-clean-1:1** remain
  rebuild-conservative (or rely on the existing cascade machinery already
  reviewed in `materialized-view-incremental-cascading-convergence`). Correct
  but untested; the true both-incremental path is filed as
  `materialized-view-incremental-join-bodies-equivalence-provenance`.

### Major — none
No correctness, type-safety, resource-cleanup, or DRY issue warranting a new
fix/plan ticket. The four deferred concerns were already filed by the
implementer.

### Validation
- `eslint` — clean. `tsc --noEmit` — clean.
- Full `packages/quereus` suite (`node test-runner.mjs`) with §22 present:
  **3793 passing, 9 pending, 0 failing** (EXIT 0). The sqllogic suite is
  file-granular (one mocha case per `.sqllogic` file), so §22's added blocks do
  not change the passing count — the green run confirms they pass, including the
  new CROSS-join assertions and the `DISTINCT over a join` create-time
  rejection.
