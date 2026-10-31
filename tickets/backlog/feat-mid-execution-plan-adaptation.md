description: When a running query discovers partway through that one of its inputs is vastly larger than planned, it could switch strategy on the spot instead of finishing with a plan that is now badly wrong — today it can only do better on the next run.
prereq: cardinality-feedback-replan
files: packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/sort.ts, packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/planner/nodes/join-node.ts, docs/progressive-optimizer.md, docs/runtime.md
tradeoffs: It is the most complex form of adaptation — a plan that changes shape inside one execution is harder to reason about, test and explain — and cardinality feedback already corrects the plan from the second execution on, so the payoff is limited to expensive queries that run once or rarely.
----

# Adapt the plan during execution

## The gap

Cardinality feedback (`docs/progressive-optimizer.md` §3) corrects a plan **between** executions: the first run of a statement over a table the planner has never seen in full runs the plan costed for a default, and only the second run benefits. For a statement that runs once — an ad-hoc analytical query, a migration step, a sync batch — or whose first run is itself very expensive (a nested-loop join chosen for an estimated 10-row inner that turns out to hold 100,000 rows), the correction comes too late.

## The opportunity

Some operators know an input's true size before downstream work begins: a hash join after building its table, a sort after consuming its input, a cache after materializing. At such a point the runtime can compare the actual count with the plan's estimate. The streaming design helps: a consumer pulls from an `AsyncIterable` and does not depend on how its producer is implemented, so the producer behind an iterator could in principle be swapped.

Options, cheapest first (carried over from the original adaptive-optimizer design):

1. **Record and continue** — note the misestimate and finish with the current plan. This is what cardinality feedback already does after the fact, for the base-table case.
2. **Operator swap at a checkpoint** — e.g. a nested-loop join whose first full inner scan reveals a large inner switches to building a hash table for the remaining outer rows.
3. **Partial re-plan** — pause at a checkpoint, re-plan the not-yet-started subtree with the observed count, resume.

## Constraints a design must respect

- Rows already emitted downstream cannot be recalled; a swap must preserve the output contract (ordering claims, duplicates, the exact row multiset).
- Side-effecting subtrees (DML inside expressions, `physical.readonly === false`) must run exactly once.
- No new pipeline breakers: a checkpoint can only sit where the operator already materializes.
- Forked parallel branches share runtime state under the fork contract (`test/runtime/fork-contract.spec.ts`).
- An existing primitive is a warning rather than a model: the row-cache abandonment threshold in `runtime/cache/shared-cache.ts` is already a runtime strategy switch, and its cliff (`bug-cache-threshold-abandon-cliff`) shows how a mid-execution switch turns into an O(N×K) regression when its threshold is wrong.

## What "done" would look like

At least option 2 for the nested-loop join case, behind its own switch, with a deterministic test proving the swap preserves results and fires only past a stated divergence.
