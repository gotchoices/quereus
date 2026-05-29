description: Set-operation (`union`/`intersect`/`except`/`union all`) `on-commit-incremental` MV bodies are accepted at create, classified whole-MV `'global'`, and maintained by a full `rebuildBacking` at COMMIT (correctness-first whole-MV recompute — the same path manual `refresh` runs). True count-based delta evaluation is deferred to `materialized-view-incremental-set-ops-delta`.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What landed

Same delivery shape as `materialized-view-incremental-recursive-cte`: a body
with no bounded per-binding residual is classified whole-MV `'global'`, and any
source mutation re-derives the entire body at COMMIT via `rebuildBacking`.
Always correct; not algorithmically incremental.

- **`planner/building/materialized-view.ts`** — deleted the (now no-op)
  build-time gate `rejectUnsupportedIncrementalBody` and its call site. All
  create-time classification now lives in `compile()` against the analyzed plan.
- **`core/database-materialized-views.ts`** — added an
  `else if (containsNodeType(analyzed, PlanNodeType.SetOperation))` branch in
  `compile()`, placed between the recursive-CTE branch and the aggregate branch,
  routing every source to `{ kind: 'global' }`. Removed the dead `SetOperation`
  rejection from the row-preserving `else` branch.
- **`docs/materialized-views.md`** — set-operation eligibility bullet
  (accepted-but-global), dropped set-ops from "Rejected up front", documented the
  `union all` bag → "must be a set"/`diverged` behavior, updated the roadmap.
- **Tests (§26-31 of `52-materialized-views-incremental.sqllogic`)** — set-op
  maintenance oracle plus the two existing sections (§7, §21) that asserted the
  old rejection now assert acceptance.

True count-based delta evaluation (multiplicity counters; bag-additive
`union all` per-binding fast path) is deferred to
`materialized-view-incremental-set-ops-delta` (in `tickets/backlog/`).

## Review findings

### Verdict

Accepted. The implementation is correct, well-decomposed, the docs are honest
and accurate, and the test coverage is genuinely thorough (stronger than the
handoff's self-assessment claimed). One minor regression-guard test was added
inline. No major findings; no new tickets filed.

### What was checked

- **The eligibility gate's soundness against optimizer rewrites (the highest-risk
  question).** The handoff flagged "confirm no set-op input can sneak onto a
  per-binding path." I traced this to ground: there is an `async-gather-union-all`
  optimizer rule (`rules/parallel/rule-async-gather-union-all.ts`) that rewrites a
  `union all` `SetOperationNode` into an `AsyncGatherNode` — which *would* hide the
  `SetOperation` node from `containsNodeType` and let a `union all` body fall onto
  the per-binding path. **It cannot fire here:** that rule is registered in
  `PassId.PostOptimization`, but `compile()` classifies against
  `optimizer.optimizeForAnalysis(...)`, which only `executeUpTo(...PassId.Structural)`
  — strictly before PostOptimization. So the `SetOperation` node always survives in
  the analyzed plan, and the gate catches all four operators (incl. `union all`,
  nested-in-subquery via §30, and `diff`'s nested `except`/`union` expansion). The
  gate is sound. *Confirmed clean.*
- **Branch ordering.** Set-op branch is placed after recursive and before
  aggregate. The comment calls the "before aggregate" placement load-bearing (an
  aggregate-bearing set-op over two sources would otherwise misroute into the
  `aggregate-over-join` rejection). This was the one explicitly-documented
  load-bearing invariant with **zero** test coverage → added §31 (minor; see
  below). *Was a gap, now covered.*
- **Dead-code removal.** `rejectUnsupportedIncrementalBody` is fully gone — zero
  references (`find_references` + `grep`), build-time call site removed, surviving
  imports (`QuereusError`/`StatusCode`/`AST`) still used elsewhere in the file.
  *Confirmed clean.*
- **Behavioral discrimination (does the global path actually fire?).** The handoff
  called the tests "correctness-only," but §26's "delete `v=10` from the left
  branch while the right branch still contributes it ⇒ `10` survives" assertion is
  a genuine behavioral discriminator: a per-binding delete would wrongly drop the
  row; only the global rebuild keeps it. The "always correct" claim is therefore
  behaviorally pinned, not just asserted. *Stronger than claimed.*
- **Bag contract.** §29 covers create-time bag (`must be a set`), late-bag
  (set-clean at create, bag after a source edit ⇒ `diverged` at COMMIT, then
  `must be a set` on refresh). Routes through the same full-rebuild path
  create/refresh use, so it enforces the contract — consistent, no silent late-bag
  dedup (the per-binding silent-dedup gap tracked in
  `materialized-view-incremental-bag-silent-dedup` is not reachable by a set-op
  body, since set-ops never take the per-binding path). *Confirmed clean.*
- **Docs.** Read `docs/materialized-views.md` end-to-end. Eligibility, "Rejected
  up front", the bag paragraph, the "Note on classification", and the roadmap's
  Incremental-refresh bullet all reflect the new reality. The delta follow-up
  backlog ticket (`materialized-view-incremental-set-ops-delta`) exists and is
  correctly cross-referenced. *Confirmed accurate.*
- **Build / lint / tests.** `build` exit 0; `lint` exit 0; full
  `@quereus/quereus test` = **3793 passing, 9 pending, 0 failing** (matches the
  handoff). Focused `52-materialized-views-incremental` passes with §31 added.

### What was done

- **Minor (fixed inline):** added §31 to
  `52-materialized-views-incremental.sqllogic` — a set-op body whose *branches*
  aggregate (`select k, count(*) … group by k union select k, count(*) … group by
  k`). It pins that the create is **accepted** (classified `'global'`, not rejected
  as `aggregate-over-join`) and that a source insert re-derives the body at COMMIT.
  This is the documented load-bearing branch-ordering invariant that previously had
  no coverage.

### Minor gaps accepted (no action — low risk, logic is sound)

- **Aggregate-inside-set-op over a single source / self-union** (same table in both
  branches) — untested, but the gate is a structural `containsNodeType`
  short-circuit that does not depend on source count or distinctness; §31 exercises
  the two-source aggregate case.
- **Empty-source set-op body** (`values(1) union values(2)`) — rejected by the
  size-0 guard before the set-op branch; the recursive §7 exercises the identical
  guard.
- **`diff`-specific test** — `diff` expands to nested `SetOperationNode`s; the §30
  nested-subquery case already covers the "not top-level" plan-walk property.
- **White-box "per-binding never runs for a set-op" assertion** — §26's
  cross-branch-survival behavior pins this indirectly; a white-box hook would be a
  stronger guarantee but is not warranted at this risk level.

### Empty categories

- **No major findings** — nothing required a new fix/plan/backlog ticket. The one
  follow-up (true count-based deltas) was already filed by the implementer as
  `materialized-view-incremental-set-ops-delta` (backlog) and is correctly scoped.

## How to validate

- Build: `yarn workspace @quereus/quereus run build` — passes.
- Lint: `yarn workspace @quereus/quereus lint` — passes.
- Tests: `yarn workspace @quereus/quereus test` — 3793 passing, 9 pending.
  Focused: `--grep "52-materialized-views-incremental"`.
