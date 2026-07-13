---
description: |
  A query that filters on an indexed column and also matches against a list produced by a
  self-contained sub-query used to crash the planner. The fix keeps such a sub-query's own
  table readable; this ticket asks a reviewer to check that fix and its regression test.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts   # guard swap + predicateContainsSubquery walker
  - packages/quereus/test/vtab/test-index-subquery-residual-module.ts   # new test module advertising a beneficial PK seek
  - packages/quereus/test/vtab/grow-retrieve-noncorrelated-subquery-residual.spec.ts  # new regression spec
  - docs/optimizer-retrieve.md                                          # subquery-residual carve-out note
difficulty: medium
---

# Review: rule-grow-retrieve subquery-residual carve-out

## What changed

Single-behavior planner fix. `rule-grow-retrieve` (`packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`)
previously kept an index-style residual predicate ABOVE the grown `Retrieve` (as a real
`FilterNode`) only when the residual held a **correlated** subquery. A **self-contained**
`IN (SELECT …)` / `EXISTS` / scalar subquery failed that guard, so its residual got stashed on
`moduleCtx.residualPredicate`. `rule-select-access-path` later rebuilds that residual into a
`Filter`, but only AFTER the bottom-up physical pass has already covered that region — so the
subquery's own inner `Retrieve` is never visited, stays unphysicalized, and
`runtime/emit/retrieve.ts` throws at execution:

```
QuereusError: RetrieveNode for table '…' was not rewritten to a physical access node.
```

### The fix

- Replaced the `predicateContainsCorrelatedSubquery` walker with a `predicateContainsSubquery`
  walker that returns true for `ExistsNode`, `ScalarSubqueryNode`, or an `InNode` with a `source`
  (subquery) — correlation no longer consulted. Dropped the now-unused
  `correlation-detector` import.
- Swapped the guard at the residual-lift site (was `:162`) to call the new walker.

Net effect: any subquery-bearing residual stays inside the plan tree the physical pass walks, so
the inner `Retrieve` physicalizes normally.

## Why the fix is guard-not-symptom

Ticket design constraint was: do NOT special-case `IN`, and do NOT de-optimize the outer scan.
The walker covers `EXISTS`, scalar subqueries, and `IN` uniformly by node type; the outer scan is
untouched (it still grows and physicalizes exactly as before — only where the residual lands
changed).

## How it was validated

- **New regression spec** `test/vtab/grow-retrieve-noncorrelated-subquery-residual.spec.ts` — 5
  cases (non-correlated `IN (subquery)` returning a row, `IN (subquery)` filtering the seeked row
  out, non-correlated `EXISTS`, non-correlated scalar subquery, and a plain `IN (subquery)` with no
  extra conjunct as a sanity case). All pass.
- **New test module** `test/vtab/test-index-subquery-residual-module.ts` — advertises a cheap
  primary-key equality seek via `getBestAccessPlan` (the in-tree memory backend never reaches the
  grow rule, so a plain memory table would NOT reproduce). Honest: its `query()` applies only the
  seek bounds the planner hands it; it claims only the PK `=` it can enforce.
- **Load-bearing confirmed**: temporarily forcing the walker to `return false` reproduced the exact
  ticket error on the inner table (`RetrieveNode for table 'other' was not rewritten…`) for all 4
  subquery cases; the plain-`IN` sanity case still passed (grow-retrieve does not fire without a
  pushed conjunct). Reverted after.
- `yarn lint` (eslint + `tsc` on src AND test) clean.
- Full quereus suite: **6982 passing, 13 pending, 0 failing** — memory suite stays green, as the
  ticket predicted (rule only reachable under an advertised access path).
- Docs: added a "Subquery-bearing residual carve-out" bullet to `docs/optimizer-retrieve.md`
  under the grow-retrieve placement policy.

## What a reviewer should scrutinize (tests are a floor, not a ceiling)

- **Walker completeness.** `predicateContainsSubquery` enumerates three node types
  (`ExistsNode`, `ScalarSubqueryNode`, `InNode` with `source`). If there is any OTHER plan-node
  shape that embeds a relational subtree with its own `Retrieve` inside a scalar predicate (e.g. a
  future `ANY`/`ALL`/row-subquery node, or a subquery reachable through a function argument that
  isn't reached by `getChildren()`), it would fall into the same buried-residual trap. Worth a
  grep for scalar nodes carrying a `RelationalPlanNode` child. The recursion relies on
  `expr.getChildren()` surfacing every subquery-bearing branch — confirm that holds for
  `BinaryOpNode`/`BetweenNode`/etc. used in residual predicates.
- **`NOT IN` / anti-join.** The `InNode` handles `IN (subquery)`; confirm a negated
  `NOT IN (subquery)` also lowers to an `InNode` with `source` (so the walker catches it) rather
  than some other node — the tests do not cover `NOT IN`.
- **Over-keeping cost.** The change keeps MORE residuals above the Retrieve than before (any
  subquery, not just correlated). That is strictly safer for correctness, but a reviewer may want
  to confirm it does not regress a case where a non-correlated subquery residual was previously
  (correctly) pushed into a query-based module via `supports()`. Note: the carve-out is gated on
  `isIndexStyleContext(moduleCtx)`, so `supports()` (query-based) modules are unaffected — but
  verify that gate reading.
- **Test module fidelity.** `TestIndexSubqueryModule` claims only a PK `=`. It does not exercise
  a residual `IS NOT NULL` conjunct (the original lamina trigger), because `IS NOT NULL` is not in
  the set this module claims and the plain memory backend cannot trigger the rule. The regression
  therefore proves the mechanism via a PK `=` conjunct, which is the same buried-residual code
  path — but it is a narrower stimulus than lamina's. The end-to-end `IS NOT NULL` form is proven
  cross-repo (see below), not here.

## Tripwire parked

- `predicateContainsSubquery` walks the full residual expression tree on every index-style grow
  that produces a residual. Recorded as a `NOTE:`-worthy concern only if residual predicates ever
  get very deep; today they are small WHERE fragments, so no code comment was added. Flagging here
  per tripwire policy: no action now.

## Cross-repo follow-up (informational, not this repo's work)

On landing, the lamina conformance file `13.1-cte-multiple-recursive.sqllogic` is expected to
advance and lamina drops its ledger line for
`quereus-grow-retrieve-buries-noncorrelated-subquery-residual`. That is lamina-side bookkeeping;
nothing to do in this repo.
