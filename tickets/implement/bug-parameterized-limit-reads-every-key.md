description: A query that filters with "in (select ...)", sorts by an indexed column and has a placeholder limit reads far more rows than the same query with the limit written out, because the row-saving choice is only made when the limit is known in advance. The choice should be made when the query runs, using the actual limit value.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # attaches the bound instead of solving a lowered break-even; holds the NOTE to remove
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # carries the bound expressions as children
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts # makes the seek-or-walk comparison at run time
  - packages/quereus/src/runtime/emit/limit-offset.ts # export resolveWindow so both agree on what a limit value means
  - packages/quereus/src/planner/optimizer.ts # registration comment, ~line 1089
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts # 'under a LIMIT' suite
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic # limit cases at ~line 490
  - docs/optimizer-rules.md # line 41
  - docs/optimizer.md # line 119
repro: verified
----
## The defect

`KeySetSemiJoinNode` (a semi join that reads its key set first, then either seeks those keys on the target table or walks the table) chooses between the two at run time. When the walk is what delivers an `order by`, the seek branch must read and sort every matching row before emitting one, while the walk streams and stops at the limit. `ruleKeySetSeekRowBound` accounts for that by lowering the node's `breakEvenKeys` (the largest key count it will seek) at plan time. It only does this when the limit and offset are literals, so any other form keeps the unbounded threshold and seeks.

The plans for `limit ?` and `limit 1` have the same shape: `LimitOffset > Project > Alias > KeySetSemiJoin`. They differ only in `breakEvenKeys`, 1000 against 56, with the same cost line (`seekAt2` 1.1, `slope` 0.3, `baselineCost` 1000).

## Reproduction

Memory backend, using `rowsScanned` from `stmt.getWorkCounters()`. `big` has 2000 rows, with `id` the primary key, `v = 2000 - id` and an index on `v`. `small` holds the 1000 odd ids. The query is `select id from big b where b.id in (select bid from small) order by b.v`, plus the suffix below. Row output was correct in every case.

| Suffix | Rows out | Read today | Read after the fix |
|---|---|---|---|
| `limit 1` | 1 | 2 | 2 |
| `limit ?` = 1 | 1 | 1000 | 2 |
| `limit :n`, n = 1 | 1 | 1000 | 2 |
| `limit ? offset 0` = 1 | 1 | 1000 | 2 |
| `limit 1 offset ?` = 0 | 1 | 1000 | 2 |
| `limit ? + 0` = 1 | 1 | 1000 | 2 |
| `limit 10` | 10 | 20 | 20 |
| `limit ?` = 10 | 10 | 1000 | 20 |
| `limit 100` | 100 | 200 | 200 |
| `limit ?` = 100 | 100 | 1000 | 200 |
| `limit 5000` | 1000 | 1000 | 1000 |
| `limit ?` = 5000 | 1000 | 1000 | 1000 |
| `limit 1 offset 998` | 1 | 1000 | 1000 |
| `limit ?, offset ?` = 1, 998 | 1 | 1000 | 1000 |

"Read after the fix" is what the literal form reads today, and it is the target. It has not been run against an implementation.

Likely a regression for this shape, from reading the old code: before `bug-absorbed-sort-blocks-key-set-seek`, `rule-key-set-seek` declined when the walk's order was load-bearing (commit `64da1811e`), which left a hash semi join streaming that walk for any limit form. The old code was not run.

## Fix

Give the node the limit and offset expressions, and make the comparison at run time, when both the key count and the bound are known. A literal limit takes this same path: one code path means the two forms cannot disagree, which is what this ticket asks for.

```ts
export interface KeySetRowBound {
	readonly limit: ScalarPlanNode;
	readonly offset?: ScalarPlanNode;
}
```

**Rule.** `ruleKeySetSeekRowBound` keeps its anchor, its peel and the `seekRestoresTargetOrder` gate. In place of solving a lower `breakEvenKeys`, it rebuilds the node with `rowBound: { limit: node.limit, offset: node.offset }`. It declines when:

- there is no `node.limit`,
- the node already has a `rowBound`, which keeps the rule idempotent if a later pass re-mints the `LimitOffset`,
- either expression is non-deterministic, has side effects, or has a relational descendant (`PlanNodeCharacteristics.isDeterministic`, `subtreeHasSideEffects`, `hasRelationalDescendant`). Those expressions are evaluated twice per execution, once here and once by `LimitOffset`, and must give the same value both times without re-reading a table. `limit (select ...)` and `limit random()` therefore keep today's behaviour.

`literalRowBound`, `literalOffset` and `boundedBreakEven` go away.

**Node.** `rowBound` is an optional seventh constructor parameter. It goes in `getChildren` after the two relations, as `LimitOffsetNode` does for its scalars, and `getRelations` stays the two relations. `withChildren` accepts 2 to 4 children and must carry `rowBound` through. Add the bound to `getLogicalAttributes` with `formatExpression`, so a plan shows it. The scalar instance is shared with the `LimitOffset`, which `plan-validator.ts` already tolerates (see its "shared child (DAG)" comment at ~line 337).

**Emitter.** Add the expressions as instruction params through `emitCallFromPlan`, as `emitLimitOffset` does. Export `resolveWindow` from `limit-offset.ts` and use it, so null, negative, non-finite and string values mean the same in both places. `bug-null-limit-returns-no-rows` in the backlog proposes changing that helper, and sharing it keeps the two in step.

After the existing `push` check, and only when it is true and the node has a `rowBound`, evaluate the bound and compare:

```ts
// seekCost(K) <= baselineCost * L / K, multiplied through by K
(seekAt2 + slope * (keys - 2)) * keys <= baselineCost * (limit + offset)
```

If that fails, walk. This is the inequality the rule uses today, now checked at the actual key count rather than solved for the largest one. For a non-negative slope the two give the same answer. A falling cost line can differ, and checking the actual count is the more accurate of the two.

Treat a resolved `limit <= 0` as no bound, as the rule does today. A pure source never opens in that case because `emitLimitOffset` returns first, so this only arises when a writing source is being drained. The trailing `NOTE:` about the even-spread estimate stays in the rule header, reworded for the run-time comparison.

**A correlated limit works and stays admitted.** `select o.n, (select id from (... limit o.n) x order by id limit 1) as r from o` plans a key-set node today and returns `[{n:1,r:1999},{n:2,r:1997}]` with `o` holding 1 and 2. The limit reads the outer row from the same run-time context in the node as in `LimitOffset`. Confirm those rows are unchanged after the fix.

### Rejected alternatives

- **Add a run-time arm and keep the literal one at plan time.** This keeps two statements of one decision. Nothing pins the lowered `breakEvenKeys` under a limit: the only assertions on that field are in `test/optimizer/key-set-seek.spec.ts` (lines 90 and 806), and neither query has a limit.
- **Have `LimitOffset` publish its window to the node through the run-time context.** That hides a dependency between two emitters that the plan cannot show, and it needs its own per-execution state keyed the way `stateByCtx` is.
- **Assume a small limit at plan time for any placeholder.** When the bound value turns out to be large, this walks where a seek would read fewer rows, and the ticket asks for no wrong plan in that case.

## Tests

Not added to the repository at this stage, because a test that fails until implement runs would break the suite for every other ticket. Add these to the `under a LIMIT` suite, whose `runCounted` needs a params argument. Each uses the 1000-key `small` from the neighbouring tests:

- One prepared statement `... order by b.v limit ?`, run with `[1]` and then `[5000]`: `[{ id: 1999 }]` reading 2, then 1000 rows reading 1000. Rerunning one statement is what proves the choice is per execution.
- `... limit ? offset ?` with `[1, 998]`: `[{ id: 3 }]` reading 1000. This pins the offset expression, which has its own evaluation path.

The existing literal tests (`limit 2`, `limit 1`, `limit 1 offset 998`, and the `min` over a nullable column case) must pass unchanged, since they now cover the run-time path.

## TODO

- Add the two tests above and see them fail with the counts in the table.
- Export `resolveWindow` from `runtime/emit/limit-offset.ts`.
- Add `KeySetRowBound` and the `rowBound` parameter to `KeySetSemiJoinNode`: children, `withChildren`, logical attributes. Reword the doc comments on `KeySetCostLine` and `breakEvenKeys`.
- Evaluate the bound and make the comparison in `emitKeySetSemiJoin`, including the bound in the existing log line.
- Rework `ruleKeySetSeekRowBound` to attach the bound, with the declines listed above. Rewrite its header and remove the `NOTE:` about literal limits.
- Update the registration comment in `optimizer.ts` (~line 1089), including its `sideEffectMode` note.
- Add one correlated-limit query to `08.4-key-set-semi-join.sqllogic`, using the rows above.
- Update `docs/optimizer-rules.md` line 41 and the "literal LIMIT" sentence in `docs/optimizer.md` line 119.
- Run the `yarn workspace @quereus/quereus` tests and lint, `yarn test:store`, and the `quereus-store` key-set spec. Secondary-index seeks on the store remain unmeasured, so record their read counts for `limit ?` in the review handoff if a quick run can get them.
