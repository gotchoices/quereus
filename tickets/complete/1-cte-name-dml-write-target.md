description: CTE-name DML write target — `update <cte>` / `insert into <cte>` / `delete from <cte>` route a leading-WITH CTE body through the existing view-mutation substrate via an ephemeral view-like adapter. Implemented and reviewed; gates green.
files:
  - packages/quereus/src/planner/building/dml-target.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/delete.ts
  - packages/quereus/src/planner/building/view-mutation-builder.ts
  - packages/quereus/src/planner/mutation/single-source.ts
  - packages/quereus/src/planner/building/select-context.ts
  - packages/quereus/src/planner/building/with.ts
  - docs/view-updateability.md
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic
----

# Complete: CTE name as a DML write target

A leading `with t as (…)` now makes the CTE name a real DML write target. `update t` /
`insert into t` / `delete from t` route the CTE body through the **same** view-mutation
substrate (`buildViewMutation`) a named view uses, via an **ephemeral** `MutableViewLike`
adapter. No grammar change — pure resolution + routing plus an `ephemeral` flag. As a side
effect, UPDATE/DELETE now thread their leading `withClause` into scope (closing a prior
read gap where a CTE read in a WHERE/SET subquery failed to resolve).

## Review findings

### Verification (gates — both green, re-run after review changes)

- `yarn workspace @quereus/quereus test` → **6190 passing, 9 pending** (before and after the
  review-added test probes; the probes ride within the existing per-file aggregate `it` for
  93.4, so the count is unchanged and the assertions pass).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `93.4-view-mutation.sqllogic` run in isolation → green with the appended probes.

### What was checked

- **Implement diff, read first with fresh eyes** (commit `8fc0add7`): the new
  `dml-target.ts`, the three builder intercepts, the `!view.ephemeral` guard, the
  `MutableViewLike.ephemeral` flag, the `isRecursiveCte` helper, the `buildWithContext`
  signature generalization, and both test-file edits.
- **Re-entry / infinite-recursion risk** (the most serious thing I looked for): traced
  `propagate` → `rewriteViewUpdate/Insert/Delete` (`single-source.ts`). The lowered base-op
  statement is built fresh with `table: tableIdentifier(analysis.baseTable)` and **no**
  `withClause`, so when `buildBaseOp` re-enters `buildUpdateStmt`/etc., `resolveCteTarget`
  sees `withClause === undefined` and returns immediately. **No recursion.** Confirmed.
- **Shadow correctness** (`with base as (select … from base) update base …`): the body's
  `from base` resolves to the REAL base table because `contextForCteTarget` removes only the
  target name from `cteNodes` and the lowered statement re-resolves through the schema
  manager. Tested and passing.
- **Halloween reject mechanism**: confirmed the "cannot be proven correlated" reject is the
  EXISTING view self-reference machinery (the `SELF_ALIAS` subquery-descent qualifier in
  `rewriteViewUpdate`) remapping `from t` to the base table, not a generic table-not-found.
  Clean reject, base unchanged — pinned by test.
- **Docs**: re-read `docs/view-updateability.md` §§ touched. The renamed section anchor
  (`#common-table-expressions-and-the-cte-name-dml-target`) is referenced from L81 and that
  link resolves; no other doc has a stale cross-reference to the old "… and Subqueries in
  `from`" anchor (`lens.md` / `sql.md` CTE mentions are unrelated). Docs reflect the new
  reality.
- **Read-gap behavior change** (UPDATE/DELETE now honor `withClause`): verified this can only
  turn prior *errors* into successes (the clause was wholly ignored before, so a CTE read
  errored). The one nuance — a leading CTE now **shadows** a same-named real table inside an
  UPDATE/DELETE subquery, matching SELECT semantics — is intended and corpus-clean (full
  suite passes). Noted below.

### Found + fixed in this pass (minor)

- **Test floor was thin on interactions.** Added three verified probes to
  `93.4-view-mutation.sqllogic` (review-added block) for cases the implement pass explicitly
  left to the reviewer:
  - `insert into <cte> select … from <sibling cte>` — the source sibling-read path (was only
    "lightly covered"); confirms the statement's CTEs thread into the INSERT source build
    while the target is shadowed out of its own body.
  - **composite-PK** CTE body update — multi-column key identification through the ephemeral
    substrate.
  - statement-level **`with context`** on a CTE-targeted INSERT (implement gap #4) — confirms
    the supplied context value threads to the lowered base op's column default
    (`default now_ms`). This was untested; it works.

### Found — filed as backlog tickets (major / deferred features, not bugs)

- **`cte-dml-halloween-self-read`** — let a user-predicate self-read of the target name
  resolve (eager-capture, Halloween-safe) instead of rejecting. Genuinely non-trivial: the
  shadow case and the Halloween case want opposite `cteNodes` treatment of the target name in
  the same statement, so it needs a split-context design. The implement pass documented and
  tested the current reject as a v1 boundary; this ticket tracks the follow-up.
- **`cte-dml-multi-level-body`** — transparent multi-level (CTE-over-CTE) write-through, today
  rejected with `no-base-lineage`. Pinned v1 boundary; lower priority.
- **`cte-dml-write-target-plan-rigor`** — structural plan-rigor: (1) a plan-shape/byte-identity
  assertion vs the equivalent view (today only observable STATE parity is asserted), and
  (2) a `view-dependency-invalidation.spec.ts` case pinning that an ephemeral target records
  no `view` dependency and is not wrongly cached against a later `create view <cteName>`. The
  review confirmed the dependency-skip by code path (the `!view.ephemeral` guard precedes both
  `validateMutationTags` and `recordDependency`); these tickets pin it under test.

### Observations (no change — documented for the record, not defects)

- **`contextForCteTarget` scope vs. `cteNodes` consistency.** It removes the target from
  `cteNodes` but leaves the registered CTE *scope* (which still carries the target's
  qualified `t.<col>` column symbols) in `ctx.scope`. I traced this and it is **inert in
  practice**: the lowered base-op statement carries no `withClause`, FROM resolution keys on
  `cteNodes` (target removed → real base), and the view-rewrite (`transformExpr` +
  `guardTopLevelScope` + `SELF_ALIAS`) remaps any view-name-qualified top-level reference
  before re-planning, so the leftover symbols are never consulted. No failing case exists. A
  defensively cleaner form would rebuild the scope from the reduced `cteNodes`, but doing so
  without a reproducing case risks perturbing sibling-CTE resolution, so I left it and
  recorded the rationale here.
- **Set-op MEMBERSHIP-bodied CTE target** (implement gap #5) left unprobed. Confirmed safe by
  code path rather than a brittle test: in `buildViewMutation` the `!view.ephemeral` guard
  (skipping `recordDependency` / `validateMutationTags`) precedes the
  `isSetOpMembershipBody` dispatch, and `buildSetOpMutation` touches no schema dependencies —
  so an ephemeral set-op body cannot crash on the schema-coupled steps. A plain (flag-less)
  union body already rejects cleanly (tested).

### Empty categories

- **Lint / type findings**: none — lint is clean including the test-file `tsc` pass.
- **Resource-cleanup / async findings**: none — this change adds no new resources, cursors, or
  lifetimes; it routes through the existing substrate's node lifecycle.
- **DRY / modularity**: clean — the new code reuses `buildViewMutation`, `buildWithContext`,
  and `isRecursiveCte` (the last extracted from inline logic in `buildCommonTableExpr` and
  shared) rather than duplicating; the `ephemeral` flag is the single new branch point.

## v1 boundaries (carried forward, all tested + documented)

- Recursive CTE target → structured `recursive-cte` reject.
- Non-decomposable body (aggregate / distinct / limit / group-by / window) → same body-shape
  diagnostic as the equivalent view.
- Multi-level CTE body → `no-base-lineage` reject (→ `cte-dml-multi-level-body`).
- User-predicate self-read of the target name → clean correlation reject, base unchanged
  (→ `cte-dml-halloween-self-read`).
- Set-op-bodied target → existing set-op reject.
- Inline `from`-subquery target (`update (select …) as v …`) → next phase
  (`cte-subquery-dml-write-target-dispatch` plan ticket).
