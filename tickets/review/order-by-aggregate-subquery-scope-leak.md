----
description: A grouped query that sorted by an aggregate subquery (like "order by (select count(*) from other)") used to crash; the fix is already written and tested — this asks for a review pass over it.
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/function-call.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic
----

# Review: ORDER BY aggregate subquery scope-leak fix

## Why this is a review ticket, not implement

The fix was **already written, committed, and tested** by a triage run
(commit `5167519f`, "tess: triage pre-existing test failure") before this ticket
reached the implement stage — the original bug surfaced as a pre-existing test
failure, so triage fixed the root cause in place rather than routing it around
the pipeline. This ticket therefore skips implement: the code exists and its
tests are green; it needs an adversarial review pass, which is the review
stage's job.

The fix agent (this run) reproduced the bug, confirmed the committed fix
resolves it, and adversarially probed for regressions (results below). No new
code was written here beyond removing a now-stale `.pre-existing-known.md` entry.

## The bug (recap)

`select o.k, count(*) from o group by o.k order by (select count(*) from c), o.k`
threw `Scalar subquery returned more than one row`. The ORDER BY subquery's own
`count(*)` was fingerprint-matched against the **enclosing** GROUP BY query's
aggregate in `buildFunctionCall` (function-call.ts:17–63) and bound to the outer
aggregate's output alias, degenerating the subquery into a multi-row column read.

## The fix under review

`packages/quereus/src/planner/building/select.ts:114–125` — after the WHERE
clause is built, the outer query's inherited `aggregates` context is dropped
from `selectContext` before this SELECT collects its own aggregates:

```ts
if (selectContext.aggregates) {
    selectContext = { ...selectContext, aggregates: undefined };
}
```

Rationale captured in the code comment: a nested SELECT must not inherit the
enclosing query's aggregate context, or its own aggregate calls (and the outer
alias like `cnt`) mis-resolve. The level repopulates `aggregates` for its own
HAVING/ORDER BY once `buildAggregatePhase` has built them (select.ts:174–178).
WHERE is built *before* the drop deliberately, so a correlated
outer-aggregate reference in a subquery's WHERE still resolves.

Tests: `packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic:154–168`
adds a correlated and an uncorrelated case. `yarn` mocha grep `07.7` → 7 passing.

## Adversarial verification already performed (for the reviewer's confidence)

Ran ad-hoc against a memory db (table `o` grouped, subqueries over `c`):

- `order by (select count(*) from c), o.k` (uncorrelated) — **OK**, sorts on the
  p.k tiebreak. Fixed.
- `order by (select count(*) from c where c.fk = o.k), o.k` (correlated) — **OK**.
  Fixed.
- `order by (select count(*) from c where c.amount < sum(o.id)), o.k` — a nested
  subquery whose WHERE **legitimately** correlates to the outer `sum(o.id)` —
  **OK**. Not a regression: ORDER BY is applied with the *repopulated* aggregate
  context, so the outer-aggregate fingerprint match still works there.
- `... having (select count(*) from c where c.amount < sum(o.id)) > 0` — HAVING
  subquery correlating to outer `sum` — **OK**.

One benign non-regression noted:

- `select o.k, sum(o.id) s, (select count(*) from c where c.amount < sum(o.id)) n
  from o group by o.k` throws `Aggregate function sum not allowed in this
  context`. This is **pre-existing and unrelated to the fix**: SELECT-list scalar
  subqueries are built in `analyzeSelectColumns` (select.ts:138) *before*
  `buildAggregatePhase` (select.ts:160) populates the outer aggregate context, so
  the outer `sum` has nothing to match and falls through to the
  aggregate-not-allowed guard (function-call.ts:66–70). The drop at 123–125 is a
  no-op at the top level (aggregates already undefined there), so it does not
  cause this. Recorded here as a tripwire, not a ticket — a forward-reference to
  an outer aggregate being computed in the same SELECT list is a niche construct;
  if a real workload needs it, the fix is to build SELECT-list subqueries after
  the aggregate phase, not to touch this scope-drop.

## What the reviewer should focus on

- **The scope-drop's blast radius.** Confirm dropping `aggregates` after WHERE
  cannot break any *other* legitimate correlated-outer-aggregate path. The
  probes above cover WHERE/ORDER BY/HAVING subqueries; consider window-function
  interaction and nested (3-level) aggregate queries.
- **Repopulation completeness.** select.ts:174–178 only repopulates when this
  level *has* aggregates. A level that references the outer aggregate but has
  none of its own would keep `aggregates: undefined` — is that reachable and
  correct? (The SELECT-list case above is the closest, and it's pre-existing.)
- **Comment accuracy** at select.ts:114–125 vs. actual behavior.

## Review findings

- Fix landed by triage (`5167519f`); reproduced and verified fixed by the fix
  run. Correlated + uncorrelated ORDER BY-aggregate-subquery cases now pass
  (07.7-scalar-agg-decorrelation.sqllogic).
- Tripwire recorded above: SELECT-list scalar subquery referencing an outer
  aggregate still errors (`Aggregate function sum not allowed in this context`) —
  pre-existing ordering limitation, not caused by this fix; noted for a future
  reader, not filed as a ticket.
- Stale `tickets/.pre-existing-known.md` entry for this scenario removed (the
  scenario is now a passing positive test).
