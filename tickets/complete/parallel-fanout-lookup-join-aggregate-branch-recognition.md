description: Fan-out lookup join now also clusters correlated scalar-aggregate subqueries (SELECT-list) as atMostOne-left branches alongside FK→PK join-spine branches. No new node mode or emitter path. Reviewed + a correctness guard added.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/cache/correlation-detector.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md, tickets/backlog/parallel-fanout-aggregate-branch-wrapped-subquery.md
----

## What landed (implement)

`ruleFanOutLookupJoin` (Structural pass, priority 23) recognizes **two** kinds of
at-most-one per-outer-row branches and combines them into one
`FanOutLookupJoinNode`:

1. **Join-spine branches** (pre-existing) — FK→PK LEFT/INNER lookups along the
   `.left` spine.
2. **Subquery branches** (new) — correlated scalar-aggregate `ScalarSubqueryNode`
   projections with no `GROUP BY`, rewritten to a `ColumnReferenceNode` into the
   fan-out's wide row.

No new `FanOutBranchMode`, no emitter/runtime changes. The branch child for a
subquery is a single-column wrapping `ProjectNode` (selecting the column-0 scalar
value), keeping the branch attribute count invariant under the inner aggregate's
logical→physical expansion. See `docs/optimizer.md` § Fan-out lookup join.

## Review findings

**Diff reviewed:** implement commit `062b116b` (rule +305/-, spec +163, docs,
backlog ticket). Read the full rule, the `FanOutLookupJoinNode` + emitter, the
correlation detector, and the runtime fork path before the handoff summary.

### MAJOR (fixed inline — small, contained)

- **Correlation to a sibling spine-branch attribute caused a runtime error.**
  The implementer flagged (under "Known gaps") that recognition used
  `isCorrelatedSubquery` (any external reference) and did not constrain the
  correlation to the outer. Reproduced concretely: a query whose subquery
  correlates to a **spine-branch** attribute (e.g. `(select count(*) from c
  where c.fk = lk.id)` with `lk` a FK→PK spine branch) clustered the subquery
  into the fan-out, then threw at runtime —
  `No row context found for column id` — because the fan-out installs only the
  *outer* row's slot before forking; a spine-branch attribute is produced inside
  the fan-out and is never an installed slot. The baseline (rule disabled)
  returns correct rows, so this was a real correctness regression for that query
  shape (gated behind a remote/high-latency vtab being in tree).
  - **Fix:** `recognizeSubqueryBranch` now requires the subquery's external
    references to be **non-empty and a subset of the outer subtree's attribute
    IDs**. Added `collectExternalReferences` to `correlation-detector.ts`
    (`isCorrelatedSubquery` refactored to share the traversal — DRY). Conservative:
    it also declines subqueries correlating only/also to a grandparent scope, which
    merely forgoes the optimization (always safe). Documented in `docs/optimizer.md`.
  - **Tests:** `correlated subquery referencing a spine-branch attribute is not
    clustered` (recognition, runs under strict-fork) + a `forkExecTest` regression
    asserting correct rows when the guard is present.

### MINOR (fixed inline)

- **Mixed-cluster (spine + subquery) execution was never run end-to-end** — the
  existing `mixed cluster` test only asserted plan shape. The subquery branch's
  wide-row read index sits *after* the spine branch there, so the `wideIndex`
  accumulation across a preceding branch was unexercised. Verified correct by
  repro and added `mixed cluster result correctness: subquery branch reads at the
  post-spine wide-row index` (`forkExecTest`, enabled-vs-disabled equivalence).

### Checked — no change needed

- **DEVIATION: single-column wrapping `ProjectNode` as the branch child** (vs.
  the ticket's "use subquery root verbatim"). Confirmed this is the right call:
  the no-`GROUP-BY` aggregate's physical `StreamAggregate` exposes source columns
  (for HAVING), so the logical 1-attr root becomes N-attr post-rule and trips
  `FanOutLookupJoinNode`'s outputAttrs-vs-child validation. The Project pins the
  branch to the scalar value and survives project-elimination (1-of-N selection
  is not an identity). The alternative (teaching the node/emitter to read only
  column 0) pushes complexity into the runtime for no benefit. Accept.
- **Wide-row index correctness** — flagged by the implementer as asserted only
  via attribute-ID resolution. Now independently exercised by the mixed-cluster
  execution test (subquery at index 4 = 2 outer + 2 spine) and the pure-subquery
  result test (indices 2,3). Resolution rides on attribute ID; index is the read
  position and is now covered for the post-spine case.
- **Cost gate / `minBranches`** — combined branch count; `expectedLatencyMs`
  propagates `max(children)` up through the aggregate, so the rule stays inert on
  local memory-vtab plans (verified by the `inert in-tree` and local-only tests).
- **Other consumers of `isCorrelatedSubquery`** (`materialization-advisory`,
  `rule-in-subquery-cache`, `rule-lateral-top1-asof`, `rule-grow-retrieve`,
  `rule-subquery-decorrelation`) — unaffected; the function's behavior is
  unchanged (now a thin wrapper over the shared collector).
- **GROUP BY / non-correlated subquery rejection, attribute-ID stability,
  empty-children `count→0` (not NULL-filled)** — covered by pre-existing tests;
  re-verified passing.

### Deferred (already tracked — not re-filed)

- **Wrapped subqueries** (`coalesce((subq),0)`, `json((subq))`) — backlog
  `parallel-fanout-aggregate-branch-wrapped-subquery`. Unchanged.
- **3-subquery concurrency (cap≥2) case** — the implementer noted the 2-branch
  subquery tests run at cap=1 (degenerate for concurrency); real concurrency is
  covered by the 3-branch spine tests. Not a correctness gap; left as-is.
- Relational 1:n product (`array`/`cross` mode) —
  `parallel-fanout-lookup-join-cross-mode`.

## Validation

- Focused spec: `node --import ./packages/quereus/register.mjs
  node_modules/mocha/bin/mocha.js "packages/quereus/test/optimizer/parallel-fanout.spec.ts"`
  → **20 passing** (was 17; +3). Strict-fork (`QUEREUS_FORK_STRICT=1`) → 14
  passing, 6 pending, **0 failing**.
- Full suite: `node packages/quereus/test-runner.mjs` → **3471 passing**, 10
  pending, no regressions (baseline 3468 + 3 new tests).
- `npx tsc --noEmit` clean; eslint clean on the three touched source/test files.
