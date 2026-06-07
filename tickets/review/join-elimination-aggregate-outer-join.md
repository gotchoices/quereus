description: Review — `ruleJoinEliminationUnderAggregate` now eliminates FK→PK LEFT/RIGHT outer joins (not just inner), so a cardinality-only aggregate (`count(*)`) over an FK→PK LEFT join collapses to zero join ops. Completes the "prune flag → eliminate join" cascade under an aggregate anchor.
files: packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate — the change), packages/quereus/src/planner/optimizer.ts (~505 + ~515 registration comments), packages/quereus/test/optimizer/rule-join-elimination.spec.ts (new `aggregate-anchored elimination` describe block + resultsNoAggElim helper), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (flipped the `count(*)` cascade test + header comment), docs/optimizer.md (~494 existence-pruning entry, ~1688 Aggregate-entrypoint bullet)
----

## What changed

`ruleJoinEliminationUnderAggregate` (the Aggregate anchor for FK→PK join
elimination) was previously `inner`-only via `if (join.joinType !== 'inner')
return null;`. It now mirrors the Project anchor (`ruleJoinElimination`)
verbatim apart from the demand prologue (group-by + aggregate exprs) and the
rebuild epilogue (reconstruct the `AggregateNode`):

- **New `hasExistenceColumns` guard** (load-bearing — see soundness below).
- **Type guard** widened to `left | right | inner`.
- **Side-selection** replaced with the Project anchor's `switch (join.joinType)`
  — the `inner` arm is byte-identical to the prior behavior (existing inner
  coverage stays green); `left` drops the right side, `right` drops the left.
- `log` message parameterized to `'Eliminating %s join under Aggregate'`.
- Function doc-comment rewritten to state the `|L LEFT JOIN R| == |L|`
  cardinality argument and the guard's role.

The shared `tryEliminate` already gates the NOT-NULL FK + `isRowPreservingPathToTable`
checks behind `if (join.joinType === 'inner')`, so the outer-join path performs
**only** FK→PK alignment (`checkFkPkAlignment`) + side-effect checks — exactly
the correct gate. No change to `tryEliminate` was needed.

Registration unchanged: `join-elimination-aggregate` stays Structural priority 26,
after `join-existence-pruning-aggregate` (priority 22). That ordering is what
makes the cascade fire in one `applyRules` pass: prune strips the undemanded flag
(flag-free LEFT join) → this rule eliminates it. Two registration **comments**
(optimizer.ts ~505 and ~515) were updated from "inner" to "left/right/inner".

## Why it's sound (LEFT; RIGHT is the mirror)

For `L LEFT JOIN R` with an FK→PK-aligned AND-of-equalities ON-clause (each L row
matches ≤1 R row), where neither a group key nor any aggregate argument references R:
LEFT preserves every L row (matched → 1; unmatched → 1 null-padded) and FK→PK caps
matches at ≤1, so `|L LEFT JOIN R| == |L|` **unconditionally** — needing neither a
NOT-NULL FK nor a row-preserving R (a null FK / filtered R simply null-pads rather
than drops). A cardinality-only aggregate over the join therefore equals the same
aggregate over L; returning L is correct. `full`/`cross` are not in the switch →
abstain.

## Soundness crux for the reviewer to scrutinize: the `hasExistenceColumns` guard

This is the one genuinely new correctness obligation (the inner-only gate made it
implicit, since `exists … as` flags only exist on outer joins). A live flag's
attribute id is **not** a column of either side, so the `usesRight`/`usesLeft`
demand scan is blind to an aggregate's dependency on it (`sum(case when hasC …)`,
`group by hasC`, `where hasC` folded via `walkChain`). Without the guard the join
would be eliminated out from under a demanded flag → wrong result. The flow:
pruning (priority 22) removes *undemanded* flags first → `hasExistenceColumns`
false → eliminate; any flag demanded → retained → `hasExistenceColumns` true →
guard abstains. **Both directions are tested** (live-flag-demanded retains;
undemanded-flag cascades to elimination). Reviewer: confirm there is no demand
shape that keeps a flag id off both side-column sets AND off `hasExistenceColumns`.

## Tests (the floor — extend, don't trust as exhaustive)

`rule-join-elimination.spec.ts` — new `describe('aggregate-anchored elimination')`
(reuses `setupCustomersOrders`: `orders.customer_id NOT NULL REFERENCES customers(id)`,
3 orders), plus a `resultsNoAggElim` helper that disables `join-elimination-aggregate`
for byte-equal baselines:

- `count(*)` over LEFT join, customers unreferenced → `joinCount === 0`, `[{ n: 3 }]`,
  byte-equal to disabled-rule baseline.
- **Nullable-FK LEFT** (`ord2.customer_id INTEGER NULL`, one NULL-FK/unmatched row)
  → still `joinCount === 0`, `[{ n: 3 }]` (unmatched row counted), baseline-equal.
  Explicit contrast with the existing inner test `does NOT eliminate INNER JOIN when
  the FK column is nullable` — same nullable FK, opposite outcome under LEFT.
- `sum(length(customers.region))` (agg arg reads R) → `joinCount > 0`, `[{ s: 6 }]`.
- `group by customers.region` (group key reads R) → `joinCount > 0`, correct groups.
- Live existence flag demanded (`sum(case when hasC …)`) → `joinCount > 0` (guard
  retains), `[{ s: 3 }]`.
- Undemanded flag → `joinCount === 0` (the cascade; locality copy of the
  existence-pruning assertion).

`rule-join-existence-pruning.spec.ts` — flipped the documented limitation:
the aggregate-anchored header comment now says the prune **cascades** to
elimination; the `count(*) … exists right as hasC` test was renamed and now
asserts `joinExistence === undefined`, `hasPhysicalJoin === false`,
`joinCount === 0`, `[{ n: 3 }]`. The `result equality … unpruned baseline` test
(uses `resultsNoPruneAgg`, disables both pruning entrypoints) still passes
unchanged.

Validation run from repo root:
- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0).
- Two targeted specs → **46 passing**.
- Full suite `yarn workspace @quereus/quereus run test` → **5111 passing, 9 pending, exit 0**. No `.sqllogic` row shifts (zero failures).
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).

## Known gaps / honest notes for the reviewer

- **RIGHT arm has zero runtime coverage — by necessity.** `runtime/emit/join.ts`
  **throws** `"RIGHT JOIN is not supported yet"` for `right`/`full`, so any RIGHT
  query errors at execution before results are produced. The builder does **not**
  normalize RIGHT→LEFT (if it did, emit would never see `'right'`). The `right`
  arm is therefore unreachable-via-SQL parity dead code — identical in status to
  the Project anchor's `right` arm, which is also untested for the same reason. I
  deliberately added no RIGHT test (it would throw). If/when RIGHT JOIN execution
  lands, both anchors' `right` arms want coverage.
- **No wrapper-chain test under the aggregate anchor for the outer case.** The new
  block only exercises the bare `Aggregate → Join` shape. `walkChain` folding
  (Filter/Sort/Distinct/Alias between the Aggregate and the LEFT join) is covered
  for inner via the Project anchor's tests but not re-verified here for the
  left/outer path. Suggested cheap addition: `count(*) … left join … where
  orders.total > 20` should still eliminate (left-side predicate folds into
  `demanded`, `usesRight` stays false) and return `[{ n: 2 }]`.
- **No composite-FK LEFT test.** The misaligned-composite abstain is covered for
  inner (Project anchor); the aggregate outer path relies on the same shared
  `checkFkPkAlignment` so it should behave identically, but it's unverified here.
- **Unrelated pre-existing editor diagnostic:** the LSP flags
  `'globalRulesRegistered' is declared but never read` at `optimizer.ts:101`. It
  predates this ticket (my optimizer.ts edits were comment-only), and `tsc
  --noEmit` + eslint both pass clean — so it is a non-failing hint, not a build
  error. Not addressed here; flagging only so the reviewer doesn't attribute it to
  this change.

## Suggested review focus

1. The `hasExistenceColumns` soundness argument above — is there any demand shape
   that evades both the side-column scan and the flag guard?
2. The `switch` parity with the Project anchor — confirm the `inner` arm is truly
   byte-identical (regression risk for existing inner coverage).
3. Whether the two suggested gap tests (wrapper-chain LEFT, composite-FK LEFT) are
   worth promoting from "suggested" to required before complete.
