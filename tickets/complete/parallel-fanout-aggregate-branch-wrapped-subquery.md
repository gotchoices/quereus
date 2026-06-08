description: Fan-out subquery-branch recognition reaches correlated scalar aggregates wrapped in a scalar expression (coalesce/arithmetic/json/cast), rewriting only the inner subquery node to a wide-row column ref while preserving the wrapper. Reviewed & complete.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## What shipped

`ruleFanOutLookupJoin` now recognizes a correlated scalar-aggregate
`ScalarSubqueryNode` reached **anywhere** in a projection's scalar expression
tree, not just when a projection node *is* a bare subquery. Two helpers:

- `collectScalarSubqueries(expr, out)` — pre-order scalar-tree walk collecting
  every `ScalarSubqueryNode`, treating a subquery as a leaf (does not descend
  into its relational body, so a nested inner subquery stays part of its
  enclosing branch child).
- `substituteSubqueries(expr, replacements)` — rebuilds the scalar tree via
  `getChildren`/`withChildren`, swapping only matched inner subquery nodes for
  their wide-row `ColumnReferenceNode`s and leaving wrappers intact.

The recognition loop dedupes by node identity (`seenSubqueries`) across
projections and gates each candidate with the unchanged `recognizeSubqueryBranch`
(same correlation / aggregate-shape / no-GROUP-BY / single-column gates). No new
`FanOutBranchMode`; same cost gate, `minBranches`, wide-row layout.

## Review findings

**Scope of review.** Read the implement diff (`b03f557d`) fresh before the
handoff: the rule changes, both new helpers, the recognition loop, `rebuildProject`
rewrite, the doc updates, and the new tests. Verified imports, the
`getChildren`/`withChildren` symmetry the helpers rely on, and the runtime
evaluation model.

**Correctness — conditional/short-circuit hoisting (the main thing I probed): CLEARED.**
The new wrapped recognition can hoist a subquery out of a `CASE` branch, a
`coalesce` 2nd arg, etc., into an eager fan-out branch. I checked whether this
changes evaluation semantics (e.g. a subquery that lazy eval would skip now runs
unconditionally, possibly raising a runtime error). It does **not**: this engine's
runtime is fully eager — `emit/case.ts` evaluates *all* when/then/else params
before the selector runs (explicit `TODO: consider making all of these calls for
short-circuiting` at `case.ts:71`), and `emit/scalar-function.ts` evaluates all
operands as params. So coalesce/CASE/arithmetic args were already evaluated
unconditionally in the baseline plan; hoisting them is semantics-preserving. The
implementer did not call this out — worth recording that the safety here rests on
the eager runtime model, so if short-circuit evaluation is ever implemented this
recognition would need a conditional-position guard.

**Type widening on the wrapper: CLEARED.** The inner subquery value column is
rewritten to a nullable colref. `BinaryOpNode.withChildren` constructs a fresh
instance and *re-infers* its type from the new children (so widening propagates
correctly); `ScalarFunctionCallNode.withChildren` preserves the original
`_inferredType` (coalesce already declares `nullable: true`). No soundness gap.
The new `o.k * 10 + coalesce(...)` exec test exercises the BinaryOp re-infer path
with correct numeric results.

**`getChildren`/`withChildren` symmetry: CLEARED.** `substituteSubqueries` passes
back exactly the `getChildren()` list (scalar children possibly replaced,
non-scalar children preserved positionally). Verified the invariant holds for
`ScalarFunctionCallNode`, `BinaryOpNode`, `AggregateFunctionCallNode`, `CastNode`
— the same pattern the CSE rule (`rule-scalar-cse.ts`) relies on.

**Dedup correctness: CLEARED.** `seenSubqueries` (by node identity) prevents a
structurally-shared subquery instance from producing two branches and two
conflicting map entries (the `Map.set` would otherwise orphan the first wide
index). Defensive and correct; not directly SQL-reachable to test.

**Minor — coverage gaps, FIXED INLINE.** Implementer tested coalesce
(ScalarFunctionCall) and `+` (BinaryOp) wrappers only, though docs/comments also
claim `cast`/`json`. Added two tests:
- `clusters a cast-wrapped subquery` — plan-shape, exercises the distinct
  `CastNode.withChildren` path;
- `wrapper mixing an outer column ref with a subquery resolves after rewrite`
  (forkExecTest) — `o.k * 10 + coalesce((subq),0)`, confirming the wrapper's
  *outer* column reference still resolves against the wide row after only the
  inner subquery is rewritten (a case the original tests did not cover).

**Strict-fork execution coverage: ACCEPTED AS-IS (no action).** The wrapped-exec
tests use `forkExecTest`, which skips under `QUEREUS_FORK_STRICT=1` — same
documented Sort-above-fan-out strict-fork false-positive as the pre-existing
subquery exec tests. The rewrite touches projection structure, not the fork
harness, so risk is low; matches the established pattern.

**DRY: ACCEPTED.** `substituteSubqueries` mirrors `replaceAllDuplicates` in
`rule-scalar-cse.ts` but with map-based (not CSE) replacement semantics;
not worth a shared abstraction.

**Docs: VERIFIED.** `docs/optimizer.md` §"Subquery branches" and the rule header
accurately describe wrapped recognition, the two helpers, multiple-per-projection
clustering, and the inner-only rewrite. No staleness found.

**Major findings: NONE.** No new tickets filed.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (EXIT 0), including new tests.
- Fanout tests (`--grep ruleFanOutLookupJoin`) — 36 passing (2 added by review).
- Full quereus suite (`test-runner.mjs --bail`) — **3554 passing, 9 pending, EXIT 0**.
  (The property-planner "rule never fired" lines are pre-existing informational
  notices, unrelated to this change.)

## Out of scope (unchanged)

- GROUP BY / multi-row subqueries (still rejected; tested).
- Subqueries in cardinality-changing positions (N/A for scalar context).
- A conditional-position guard would be needed only if short-circuit evaluation
  is ever added to the runtime (see review findings).
