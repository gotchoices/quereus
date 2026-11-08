description: A sort or window that asks for NULLs last can return them first, or number them wrongly, because the planner's record of "these rows are already in order" has no place for where NULLs go and silently treats NULLS LAST as the default. Stop the planner from claiming or accepting an ordering when NULLs are asked to go last.
architecture: docs/invariants.md#opt-060--an-ordering-claim-over-a-descending-key-column-excludes-nulls
files: packages/quereus/src/planner/framework/physical-utils.ts (`Ordering`, `extractOrderingFromSortKeys`), packages/quereus/src/planner/nodes/sort.ts (`computePhysical` — `monotonicOn`), packages/quereus/src/planner/nodes/window-node.ts (`windowSortKeys`, `computePhysical` — `monotonicOn`, stale NOTE), packages/quereus/src/planner/rules/window/rule-monotonic-window.ts (`ruleMonotonicWindow`), packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (`PlanNodeType.Sort` arm, log text only), docs/invariants.md, docs/window-functions.md, packages/quereus/test/optimizer/explicit-nulls-ordering.spec.ts (new, repro), packages/quereus/test/logic/27.4-window-nulls-placement.sqllogic (new, repro)
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids the module case by never claiming an ordering over a nullable column, and keeps its own copy as a blocked ticket, `quereus-explicit-nulls-placement-is-lost-when-an-index-serves-order-by`.

## Background

The engine places NULLs first in both directions by default (`orderByNullResult`, `src/util/comparison.ts`). `nulls first` written explicitly is therefore the same as the default; only `nulls last` differs from it.

The planner records "this node's rows come out sorted like this" as `physical.ordering` (`Ordering = { column, desc }`, `planner/framework/physical-utils.ts`) and the stronger `physical.monotonicOn` (`{ attrId, direction, strict }`, `planner/nodes/plan-node.ts`). Neither has a NULL-placement field. Every producer and consumer implicitly assumes the default placement, the same convention the module side already follows (invariant OPT-060, and `OrderingSpec` in `vtab/best-access-plan.ts`, whose `nullsFirst` nothing fills).

`extractOrderingFromSortKeys` builds an `Ordering` from sort keys and has no `nulls` in its parameter type, so `s asc nulls last` comes out as `{ s, asc }`, which is indistinguishable from the default.

## Reproduced (all verified on HEAD, 2026-11-07)

Three wrong results, one cause:

- **A module that claims the ordering** (the original report). `select * from t order by s nulls last` over a module whose `getBestAccessPlan` echoes any `requiredOrdering` back as `providesOrdering` plans as a bare `INDEXSCAN` with no Sort and returns `null, a, b`. The `PlanNodeType.Sort` arm of the index-style path in `rule-grow-retrieve.ts` builds `request.requiredOrdering` through `extractOrderingFromSortKeys`, so the module is asked for plain `s asc` and the Sort is dropped. The other route, `trySortAbsorbViaIndexOrdering`, already refuses any key with explicit `nulls`. The memory module is not affected here only because the Sort sits above a Project when the select list is reordered; `select *` and `select id, s` put it directly on the table access. Repro: `test/optimizer/explicit-nulls-ordering.spec.ts`.
- **A window over a NULLS LAST source, plain memory table.** `select s, row_number() over (order by s) as rn from (select * from wn order by s nulls last)` gives `a=1, b=2, null=3`; correct is `null=1, a=2, b=3`. The inner `SortNode` advertises `{ s, asc }`, `ruleMonotonicWindow` accepts it as satisfying the window's default `order by s`, and the window streams in the source's order.
- **A NULLS LAST window over a default-ordered source, plain memory table.** `select s, row_number() over (order by s nulls last) as rn from (select * from wn order by s)` gives `null=1, a=2, b=3`; correct is `a=1, b=2, null=3`. `ruleMonotonicWindow` compares column and direction only and never reads the window's own `orderBy[i].nulls`.

Repro for both window cases: `test/logic/27.4-window-nulls-placement.sqllogic`.

The `NOTE:` in `WindowNode.computePhysical` claims the missing placement is harmless "while every ordering consumer is null-placement-blind". `ruleMonotonicWindow` is a consumer, and it does depend on placement, so the claim is wrong.

## Fix

Make "an ordering or monotonic claim means the default NULL placement" an explicit invariant, and enforce it at the producers and the one consumer that builds a requirement from user sort keys:

- `extractOrderingFromSortKeys`: add `nulls?: 'first' | 'last'` to the sort-key parameter type and return `undefined` when any key has `nulls === 'last'`. Keep it all-or-nothing, as it is today for computed keys. Returning a prefix would be wrong for the grow-retrieve Sort arm, which drops the whole Sort once the module serves the request. Document the convention on the `Ordering` interface. This single change fixes the module case (confirmed by applying it: the spec goes green) and `SortNode`'s `ordering`.
- `SortNode.computePhysical`: withhold `monotonicOn` when the leading key has `nulls === 'last'`, because NULL is the lowest value and NULLs at the end are not ascending.
- `WindowNode`: pass `nulls` through `windowSortKeys()` so its `ordering` is withheld the same way; withhold `monotonicOn` when `windowSpec.orderBy[0].nulls === 'last'`; replace the stale NOTE with a one-line statement of the convention.
- `ruleMonotonicWindow`: decline when any `windowSpec.orderBy` key has `nulls === 'last'`. No source can advertise that placement once the producers above are fixed, so declining is exact, not merely conservative.
- `rule-grow-retrieve.ts` Sort arm: no logic change needed once the helper refuses. Update the log message, which currently blames "non-trivial expressions", so it also covers the NULLS LAST case.

A temporary patch of exactly these sites was applied during the fix stage and then reverted. With it, both repro tests pass and `yarn test` in `packages/quereus` passed 11109 with 26 pending and no plan-golden changes.

Out of scope:
- Filling `OrderingSpec.nullsFirst` so a module could serve an explicit placement instead of the planner declining.
- Relaxing `trySortAbsorbViaIndexOrdering`'s refusal from any explicit `nulls` to `nulls === 'last'`.
- Dropping an explicit placement on a NOT NULL column so such a query keeps its index.

All three are later optimizations, and the planner is correct without them.

The class (an unchecked ordering claim) is tracked by `debt-nothing-checks-advertised-row-order` in backlog; this instance is appended there as evidence.

## TODO

- Change `extractOrderingFromSortKeys` and document the convention on `Ordering` (physical-utils.ts).
- Withhold `monotonicOn` for a leading `nulls last` key in `SortNode.computePhysical`.
- `WindowNode`: thread `nulls` through `windowSortKeys`, withhold `monotonicOn` for a leading `nulls last`, replace the stale NOTE.
- `ruleMonotonicWindow`: decline on any `nulls last` window ORDER BY key.
- Adjust the grow-retrieve Sort arm's log message.
- Add an OPT invariant to `docs/invariants.md` beside OPT-060: an ordering or monotonic claim, and a requirement built from sort keys, always mean the default NULL placement (NULLs first, both directions); a sort or window asking for NULLS LAST neither advertises nor accepts one. Cite the two repro tests as guards. Mention it in `docs/window-functions.md` § "What the `WindowNode` advertises as its emit order".
- Run `test/optimizer/explicit-nulls-ordering.spec.ts` and the `27.4` logic file (both fail on HEAD), then `yarn test` and `yarn lint` in `packages/quereus`.
