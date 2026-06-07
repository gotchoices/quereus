description: Extend `ruleJoinEliminationUnderAggregate` to eliminate FK→PK OUTER (left/right) joins, not just inner — so a cardinality-only aggregate (`count(*)`) over an FK→PK LEFT join collapses to zero join ops. Delivers the "prune flag → eliminate join" cascade the existence-pruning ticket assumed but could not reach (aggregate-elimination was inner-only).
files: packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate — the change), packages/quereus/test/optimizer/rule-join-elimination.spec.ts (new aggregate-anchored elimination describe block), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (the `count(*)` aggregate-anchored test currently pins joinCount===1 / hasPhysicalJoin===true; both flip to elimination), docs/optimizer.md (lines ~494 existence-pruning entry "does not cascade" caveat; line ~1688 Aggregate-entrypoint bullet)
----

## Summary

`ruleJoinEliminationUnderAggregate` (in `rule-join-elimination.ts`) is the
Aggregate-anchored sibling of `ruleJoinElimination` (the Project anchor). The
Project anchor already eliminates FK→PK `left`/`right`/`inner` joins; the
Aggregate anchor restricts itself to `inner` via `if (join.joinType !== 'inner')
return null;`. Extend it to `left`/`right` by mirroring the Project anchor's
join-type switch — making the two entrypoints structurally identical except for
the demand prologue (group-by + aggregate exprs) and rebuild epilogue
(reconstruct the `AggregateNode`).

## Why this is sound (LEFT case; RIGHT is the mirror)

For `L LEFT JOIN R` with an FK→PK-aligned AND-of-equalities ON-clause (each L row
matches ≤1 R row) where neither a group key nor any aggregate argument references
R:

- LEFT preserves every L row (matched → 1 row; unmatched → 1 null-padded row) and
  FK→PK guarantees ≤1 match, so `|L LEFT JOIN R| == |L|` **unconditionally**.
- Therefore any aggregate whose value depends only on cardinality / the L side
  (`count(*)`, and anything not reading R) equals the same aggregate over L
  alone; returning L is correct.
- Unlike the inner case this needs **neither** a NOT-NULL FK **nor** a
  row-preserving path to R's base table: a null FK or a filtered R simply
  null-pads the L row rather than dropping it, so cardinality is unchanged. The
  shared `tryEliminate` already gates the NOT-NULL + `isRowPreservingPathToTable`
  checks behind `if (join.joinType === 'inner')`, so for outer joins it performs
  exactly (and only) the FK→PK alignment + side-effect checks — the correct gate.

`full` joins are out of scope (both sides preserved). The existing
`usesRight`/`usesLeft` demand gate already prevents eliminating a side the
aggregate reads.

## The change (`ruleJoinEliminationUnderAggregate`)

Replace the inner-only guard:

```ts
const { join, chain } = walk;
// Only inner-eliminable shapes — see `ruleJoinElimination` notes.
if (join.joinType !== 'inner') return null;
if (!join.condition) return null;
```

with the Project anchor's guards (note the **mandatory new `hasExistenceColumns`
guard** — see Edge cases):

```ts
const { join, chain } = walk;
// A live `exists … as` flag's attr id is not a column of either side, so the
// usesRight/usesLeft demand scan cannot see its dependency on the non-preserved
// side — eliminating out from under it would be unsound. (The inner-only gate
// used to make this guard implicit, since flags only exist on outer joins.)
if (join.hasExistenceColumns) return null;
if (join.joinType !== 'left' && join.joinType !== 'right' && join.joinType !== 'inner') return null;
if (!join.condition) return null;
```

and replace the side-selection block:

```ts
let preserved: RelationalPlanNode | null = null;
if (!usesRight) {
	preserved = tryEliminate(join, 'right', pairs);
}
if (!preserved && !usesLeft) {
	preserved = tryEliminate(join, 'left', pairs);
}
```

with the Project anchor's switch (the `inner` arm is byte-identical to today's
behavior, so existing inner coverage stays green):

```ts
let preserved: RelationalPlanNode | null = null;
switch (join.joinType) {
	case 'left':
		if (usesRight) return null;
		preserved = tryEliminate(join, 'right', pairs);
		break;
	case 'right':
		if (usesLeft) return null;
		preserved = tryEliminate(join, 'left', pairs);
		break;
	case 'inner':
		if (!usesRight) {
			preserved = tryEliminate(join, 'right', pairs);
		}
		if (!preserved && !usesLeft) {
			preserved = tryEliminate(join, 'left', pairs);
		}
		break;
}
```

Update the `log(...)` string from `'Eliminating inner join under Aggregate'` to
`'Eliminating %s join under Aggregate'` with `join.joinType`, and rewrite the
function's doc-comment block (the "Only `inner` joins are eligible … outer joins
reduce to inner …" paragraph) to state that left/right are now eligible and why
(the `|L LEFT JOIN R| == |L|` cardinality argument above), and to call out the
`hasExistenceColumns` guard's role.

No change to the optimizer registration: `join-elimination-aggregate` stays at
Structural priority 26, after `join-existence-pruning-aggregate` (priority 22).
That ordering is what makes the cascade work in one `applyRules` pass — pruning
strips the unused flag first (flag-free LEFT join), then this rule eliminates it.
The registration comment at `optimizer.ts:~513` ("Drops the non-preserved side
of an **inner** join…") should be updated to "left/right/inner".

## Edge cases & interactions

- **Live existence flag (the soundness crux).** Once outer joins are eligible,
  the `hasExistenceColumns` guard is **load-bearing and mandatory**. A demanded
  flag (`sum(case when hasC …)`, `group by hasC`, `where hasC` folded in via
  `walkChain`) keeps its attr id off the left/right column sets, so
  `usesRight`/`usesLeft` are blind to it; without the guard the join would be
  eliminated out from under the flag. The pruning rule (priority 22) removes
  *undemanded* flags before this rule sees the node, so: all flags undemanded →
  gone → `hasExistenceColumns` false → eliminate; any flag demanded → retained →
  guard abstains. Test both directions.
- **Nullable FK under LEFT** → still eliminated (LEFT keeps unmatched rows),
  explicitly distinct from the inner case which requires NOT-NULL. This is the
  case the inner-only gate silently blocked.
- **Aggregate reads the non-preserved side** (`sum(customers.x)`, or `group by`
  on a non-preserved column) → `usesRight`/`usesLeft` true → retained.
- **`full` / `cross` joins** → not in the switch → `preserved` stays null →
  abstain (unchanged).
- **RIGHT joins.** Mirror the Project anchor's `right` arm verbatim. Confirm
  whether the builder normalizes RIGHT→LEFT before the optimizer; if it does,
  the `right` arm is harmless dead code (exactly as in the Project anchor) — do
  not special-case it, just keep parity. Note the finding in the review handoff.
- **Non-FK / misaligned-composite / non-equi-residual ON-clause** → the shared
  `isAndOfColumnEqualities` + `checkFkPkAlignment` gates abstain (unchanged).
- **Write on the eliminable side** → `tryEliminate`'s `subtreeHasSideEffects`
  check refuses (unchanged; `sideEffectMode: 'aware'`).
- **Result equality** vs the rule-disabled baseline must hold byte-for-byte
  across every shape above (the rule is a pure optimization).

## Test plan

**`rule-join-existence-pruning.spec.ts` — flip the documented limitation.**
The `describe('aggregate-anchored pruning')` block has a header comment (≈ lines
383–388) stating the prune "does **NOT** cascade to join elimination" and a test
`'an unused flag under count(*) is pruned, re-enabling physical join selection'`
(≈ lines 390–406) pinning `joinExistence === undefined`, `hasPhysicalJoin ===
true`, `joinCount === 1`. With this change the join is eliminated:
- Rewrite that header comment — pruning under an aggregate now **does** cascade
  to elimination for FK→PK outer joins.
- Update the test (rename to reflect elimination): keep
  `joinExistence === undefined`, change `joinCount` to `0`, change
  `hasPhysicalJoin` to `false`, keep `result === [{ n: 3 }]`.
- The `'result equality: pruned count(*) matches the unpruned baseline'` test
  (uses `resultsNoPruneAgg`, which disables both pruning entrypoints) should
  still pass unchanged — elimination preserves the `{ n: 3 }` result. Verify.

**`rule-join-elimination.spec.ts` — new `describe('aggregate-anchored
elimination')` block** (this spec has no aggregate coverage today; reuse its
`setupCustomersOrders()` — `orders.customer_id NOT NULL REFERENCES
customers(id)`):
- `count(*)` over `orders LEFT JOIN customers on orders.customer_id =
  customers.id`, customers otherwise unreferenced → `joinCount === 0`, result
  `[{ n: 3 }]` (== the 3 orders rows), byte-equal to a disabled-rule baseline
  (disable `join-elimination-aggregate` via `db.optimizer.updateTuning`, mirror
  the `resultsNoPrune` helper pattern).
- Nullable-FK LEFT variant (a second table whose FK column omits NOT NULL, with
  at least one unmatched/orphan row) → still `joinCount === 0`; result equals the
  baseline (the unmatched L row is counted). Contrast: the existing inner test
  `'does NOT eliminate INNER JOIN when the FK column is nullable'` keeps the join
  — same nullable FK, opposite outcome under LEFT.
- `sum(customers.region-derived value)` (aggregate reads R) → `joinCount > 0`
  (retained).
- `group by customers.region` → `joinCount > 0` (retained).
- Live existence flag: `count(*) from orders left join customers on … exists
  right as hasC` where `hasC` IS demanded (e.g. `sum(case when hasC then 1 else 0
  end)`) → `joinCount > 0` (the `hasExistenceColumns` guard retains it); and the
  fully-undemanded `count(*) … exists right as hasC` → `joinCount === 0` (this is
  the cascade, also covered in the existence-pruning spec — keep one assertion
  here for locality).

**Docs (`docs/optimizer.md`).**
- Line ≈494 (`ruleJoinExistencePruning` / `…UnderAggregate` entry): drop the
  closing "**Note on the aggregate anchor:** … does **not** cascade to join
  *elimination* … would require extending `ruleJoinEliminationUnderAggregate` to
  outer joins" sentence — that extension now exists. Replace with a one-line
  statement that the freshly-pruned flag-free outer join is now eliminated under
  the aggregate (the headline cascade).
- Line ≈1688 (Inclusion-dependency reasoning, "rule-join-elimination (Aggregate
  entrypoint)" bullet): broaden from "the **inner** join is FK-covered" to cover
  left/right outer joins, noting the LEFT case needs neither NOT-NULL nor a
  row-preserving R (the `|L LEFT JOIN R| == |L|` argument).

## Validation

Run from repo root, streaming so the idle timer never expires:

```
yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/tj.log; tail -n 60 /tmp/tj.log
```

Then lint the touched package (single-quote globs on Windows):
`yarn workspace @quereus/quereus run lint`.

If a `.sqllogic` result-row test shifts, it should only be because a plan now
eliminates a join while returning identical rows — investigate any *row* change
(that would be a real bug); a pure plan-shape shift with identical rows is the
expected effect.

## TODO

- Edit `ruleJoinEliminationUnderAggregate`: add `hasExistenceColumns` guard +
  left/right/inner type guard; swap the side-selection block for the Project
  anchor's join-type switch; parameterize the `log` message; rewrite the
  function doc-comment.
- Update the `join-elimination-aggregate` registration comment in `optimizer.ts`
  (~line 513) from "inner join" to "left/right/inner".
- Update `rule-join-existence-pruning.spec.ts`: rewrite the aggregate-anchored
  header comment and flip the `count(*)` test to assert elimination
  (`joinCount === 0`, `hasPhysicalJoin === false`).
- Add the `aggregate-anchored elimination` describe block to
  `rule-join-elimination.spec.ts` (cardinality-only eliminated, nullable-FK LEFT
  eliminated, R-reading retained, group-by-on-R retained, live-flag retained,
  result equality vs disabled-rule baseline).
- Update `docs/optimizer.md` lines ~494 and ~1688.
- Run `yarn workspace @quereus/quereus run test` (streamed) + `lint`; confirm
  green and that any `.sqllogic` shifts are plan-only with identical rows.
