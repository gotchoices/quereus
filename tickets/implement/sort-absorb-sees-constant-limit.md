description: When a query sorts and then takes a fixed number of rows ("order by date limit 20"), tell the storage backend how many rows are wanted, so a backend with slow random reads can choose to read 20 rows through an index instead of scanning and sorting the whole table.
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # ruleGrowRetrieve entry; trySortAbsorbViaIndexOrdering (~:835) and its doc comment; RowsWanted; probeAccessPlan
  - packages/quereus/src/planner/nodes/limit-offset.ts  # constantNumber — the plan-time reading of a LIMIT / OFFSET constant
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # existing rowsWanted caller; comment at ~:103 says a user limit is invisible
  - packages/quereus-store/src/common/store-module-access-plan.ts  # NOTE on chooseOrderingPlan (~:1191) says only an engine-synthesized limit arrives
  - packages/quereus-store/test/plan-time-limit.spec.ts  # cost-profile-parameterized harness; the 'end to end, on the backend that reported it' block
  - docs/optimizer-retrieve.md  # "trySortAbsorbViaIndexOrdering is exported and has two callers" paragraph
  - docs/module-authoring.md  # ~:193 "limit is a licence" — say a user-written LIMIT now reaches the module
----
# A constant LIMIT above a Sort reaches the module

## Background

`trySortAbsorbViaIndexOrdering` (rule-grow-retrieve.ts) decides whether a `Sort` can be dropped because the table's access plan already delivers its order. It asks the module with `requiredOrdering` set, and since `feat-sort-absorb-blind-to-limit` it can also send `BestAccessPlanRequest.limit` / `.offset` through an optional `rowsWanted` argument. `probeAccessPlan` keeps the limit only when `truncationIsSafe` proves nothing below the Sort can discard a row, and the store prices its ordered arms against `limit + offset` when present (`rowsToProduce`).

Only `ruleMinMaxIndexBoundary` passes `rowsWanted`. A user-written limit sits above the Sort; the builder produces

```
LimitOffset
  └─ Project            (absent for an identity `select *`)
       └─ Sort
            └─ Filter* / Project* / Alias*
                 └─ Retrieve
```

and `ruleGrowRetrieve` reaches the Sort from the Sort itself, so it has nothing to pass. On IndexedDB (`pointRead` 3.0) `select * from t where owner = ? order by date limit 20` through an `(owner, date)` index is priced as resolving every owner row, loses the seek-versus-scan veto, and runs as a full scan plus sort (GitHub #36: ~200 ms for 20 rows).

## Decision (maintainer, 2026-11-10)

Teach the rule to look *upward*: when `ruleGrowRetrieve` is offered a `LimitOffsetNode`, it looks down from it to a `Sort` and calls the absorb with the limit. No fused sort-and-limit node. This ticket covers a LIMIT and OFFSET that are both plan-time constants. A placeholder limit (`limit ?`), which needs a run-time decision, is the follow-on `sort-absorb-runtime-limit-choice`.

## Design

In `ruleGrowRetrieve`, before the existing `findRetrieveChild` handling, add a `LimitOffsetNode` arm (its own small function, e.g. `tryLimitedSortAbsorb(limitNode, context)`):

1. Require `limit` to be present. Read it with `constantNumber` (limit-offset.ts). The OFFSET is absent (read as 0) or also `constantNumber`. Use `Math.trunc` on both, the same as the runtime `toRowCount`. If either is not a constant, return null here (the follow-on ticket fills this branch). Negative and null constants cannot reach the planner; `buildRowCountExpression` rejects them at prepare time.
2. Look down from `limitNode.source` through `ProjectNode` and `AliasNode` only. Both pass each row through unchanged and keep order. Stop at anything else. A `Filter` or `Distinct` between the limit and the Sort discards rows after ordering, so the scan would have to read past the limit; do not look through them. If the node reached is not a `SortNode`, return null.
3. Call `trySortAbsorbViaIndexOrdering(sort, context, { limit, offset })`. On null, return null. The Sort visit later in the same pass still makes its limit-free attempt, so a decline here changes nothing.
4. On success, rebuild the path from `limitNode` down to the Sort with the absorbed subtree in the Sort's place. `rebuildChain` in `rules/shared/access-leaf.ts` is the helper `rule-key-set-seek-row-bound` uses for this. Return the new `LimitOffset`.

`LimitOffset` is already in `GROW_RETRIEVE_NODE_TYPES` (optimizer.ts), so this needs no new registration. The pass is top-down, so the LimitOffset is visited before the Sort beneath it, and the limit-aware attempt comes first.

Leave the existing `fallbackIndexSupports` LimitOffset arm alone: that path *swallows* a LimitOffset sitting directly on a Retrieve, and its "a bare `LIMIT n` is refused" note stays load-bearing for `rule-minmax-index-boundary`. This arm never swallows the LimitOffset. It stays above the rebuilt chain and executes there.

Update the comments that say a user limit is invisible: the `trySortAbsorbViaIndexOrdering` doc comment ("Only `rule-minmax-index-boundary` can…"), the comment in `rule-minmax-index-boundary.ts` near the `rowsWanted` call, and the `NOTE:` on `chooseOrderingPlan` in store-module-access-plan.ts. After this ticket they should say that constant limits arrive and placeholder limits do not yet. The follow-on ticket updates them again.

Docs: in `docs/optimizer-retrieve.md`, the "two callers" paragraph now covers three entry points: the Sort visit, the LimitOffset visit with a constant bound, and minmax. In `docs/module-authoring.md` near "`limit` is a licence", say that a user-written constant `limit` / `offset` above an `ORDER BY` now reaches the module when truncation is safe.

## Edge cases & interactions

- **Unclaimed filter below the Sort** (`where b = 1 and u > 2 order by c limit 20`, `u` unindexed): `probeAccessPlan` strips the limit and re-asks, so the plan is the same as today. Verified by the existing `truncationIsSafe` coverage; no new test.
- **Filter or Distinct between LimitOffset and Sort**: the look-down stops there and the rule declines. Verified by inspection.
- **`limit 0`**: absorbing is harmless (`rowsToProduce` floors at 1 row of pricing, and the LimitOffset still emits nothing). By inspection.
- **Explicit `offset`** (`limit 20 offset 40`): the request carries `offset: 40` and the store prices `limit + offset`. The existing pricing test "the bound is limit + offset" covers the module side. After the rewrite, a LimitOffset with an explicit numeric OFFSET directly over the equipped Retrieve (no Project, identity `select *`) can later be swallowed by the existing `fallbackIndexSupports` LimitOffset arm. That already happens today on the parity backend for the same query, so nothing new. By inspection.
- **Parity (memory, cheap `pointRead`) backends**: the limit-free plan already delivers the ordering, so the plan is unchanged and only the pricing differs. The whole quereus suite running green is the check.
- **Projection with side effects or a subquery between LimitOffset and Sort**: a writing projection makes `emitLimitOffset` drain its source on purpose, so the ordered walk reads every row. That is correct and is never worse than the plan today. By inspection.
- **Sort keys the absorb refuses** (expressions, explicit `NULLS`): `trySortAbsorbViaIndexOrdering` returns null as it does today.
- **Rewrite not re-offered**: the framework marks `grow-retrieve-LimitOffset` applied on the old node and copies that mark to the result, so the rule does not loop on its own output.
- **Isolation layer**: more requests now carry a limit, which widens the reach of backlog `bug-isolation-forwards-plan-time-limit-to-underlying` (only out-of-tree modules that actually stop at the limit are affected). Out of scope here; a note was added to that ticket.

## Tests

Extend `packages/quereus-store/test/plan-time-limit.spec.ts`, end-to-end block, on the IndexedDB profile (`INDEXEDDB_PROFILE`), using the existing `ix_bc on t(b, c)` fixture, which is the #36 `(owner, date)` shape with `b` as owner and `c` as date. Size the fixture the way the existing `min` end-to-end case does, so that without a limit the seek loses the veto:

- `select * from t where b = 1 order by c limit 20`: `query_plan` shows no `SORT` and an access on `ix_bc`. The rows equal those from the same query on the parity profile, or from an inline sort of the full result. This is the reproduction: it fails before the change.
- Optionally, the same with `order by c desc` on the `descC` fixture (the #36 "latest N" spelling). Add it only if it goes through code the ascending case does not.

No memory-backend plan test: it cannot fail on this.

## TODO

- Add the LimitOffset arm to `ruleGrowRetrieve` (constant limit/offset, look down through Project/Alias to a Sort, absorb with `rowsWanted`, rebuild the chain).
- Update the three comments that say a user limit is invisible.
- Update `docs/optimizer-retrieve.md` and `docs/module-authoring.md`.
- Add the IndexedDB-profile end-to-end case to `plan-time-limit.spec.ts`.
- `yarn workspace @quereus/quereus run lint`, `yarn workspace @quereus/quereus run test`, and `yarn workspace @quereus/store run test`.
