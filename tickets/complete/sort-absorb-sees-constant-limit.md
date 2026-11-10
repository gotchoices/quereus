description: When a query sorts and then takes a fixed number of rows ("order by date limit 20"), the storage backend is now told how many rows are wanted, so a backend with slow random reads can choose to read 20 rows through an index instead of scanning and sorting the whole table.
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # LimitOffset arm at the top of ruleGrowRetrieve; tryLimitedSortAbsorb / constantRowsWanted / sortUnderLimit after trySortAbsorbViaIndexOrdering
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # comment at the rowsWanted call
  - packages/quereus-store/src/common/store-module-access-plan.ts  # NOTE on chooseOrderingPlan
  - packages/quereus-store/test/plan-time-limit.spec.ts  # end-to-end case
  - docs/optimizer-retrieve.md  # "three entry points" list
  - docs/module-authoring.md  # "limit is a licence" paragraph
----
# A constant LIMIT above a Sort reaches the module

## What changed

`ruleGrowRetrieve`, when offered a `LimitOffsetNode`, first calls `tryLimitedSortAbsorb`:

- `constantRowsWanted` reads LIMIT and OFFSET with `constantNumber` (absent OFFSET = 0), truncates both, and returns nothing if either is not a plan-time constant. Placeholder limits (`limit ?`) are the follow-on `sort-absorb-runtime-limit-choice`.
- `sortUnderLimit` walks down from the LimitOffset's source through `ProjectNode` / `AliasNode` only and must land on a `SortNode`. A Filter or Distinct in between stops the walk.
- It calls `trySortAbsorbViaIndexOrdering(sort, context, { limit, offset })`. On success it rebuilds LimitOffset → … → (absorbed chain) with `rebuildChain`. The LimitOffset stays above and executes; it is never swallowed into the Retrieve.
- On decline it falls through to the existing handling unchanged, and the later Sort visit still makes its limit-free attempt.

No registration change: `LimitOffset` was already a grow-retrieve node type, and the Structural pass is top-down, so the limit-aware attempt runs before the Sort visit.

Comments and docs updated: the `trySortAbsorbViaIndexOrdering` doc comment, the min/max rule comment, the store `chooseOrderingPlan` NOTE, `docs/optimizer-retrieve.md`, `docs/module-authoring.md`.

Test: `plan-time-limit.spec.ts` › end to end › "a constant LIMIT the user wrote above an order by reaches the module" (IndexedDB cost profile, 200 rows). It asserts the unlimited query still sorts, the `limit 20` query uses `ix_bc` with no SORT, and the rows are correct.

## Review findings

Read the implement diff (`ticket(implement): sort-absorb-sees-constant-limit`) before the handoff, then the surrounding code: `probeAccessPlan` / `truncationIsSafe`, `fallbackIndexSupports` (including its LimitOffset swallow arm and the accepted-tradeoff NOTE), `rebuildChain`, `constantNumber` / `buildRowCountExpression`, and the pass framework's applied-rule marks and top-down finalize (`framework/pass.ts`).

**Correctness: checked by running, no defect found.** I ran a throwaway probe spec (since deleted) that compared each limited query with the unlimited query's rows sliced in JS. It covered three backends (memory, store at parity, store with the IndexedDB profile) and both ascending and descending `ix_bc`. Shapes: `limit 20`; `desc limit 7 offset 2`; a Project above the Sort; an Alias subquery; `limit 0`; `limit 2.7`; a Sort directly on the Retrieve with an OFFSET, in both directions; `order by id`; an unclaimed residual (`u > 2`, where the limit is correctly stripped); `b in (0, 1)`; a range plus equality; `distinct` (the walk stops, Sort kept); an OFFSET past the end (`offset 200`, where IndexedDB correctly keeps scan-then-sort); a correlated scalar subquery with `limit 1 offset 1`; `count(*)` over a limited subquery. All 84 combinations returned the right rows. The plans matched the ticket's description.

**Swallowing a LimitOffset over an equipped Retrieve: checked, safe.** The rebuilt LimitOffset inherits the `grow-retrieve-LimitOffset` applied mark, and top-down finalize never re-applies rules to a parent rebuilt after its children change (`pass.ts` finalizeNode with `applyRulesAfter = null`). `grow-retrieve` is registered in the Structural pass only. So the swallowing arm cannot reach the new node. Explicit OFFSET cases passed on all backends.

**`orderingLoadBearing` for a Sort directly on a Retrieve: checked, intended.** Under a constant LIMIT this shape now takes the absorb path and is marked load-bearing. Before, the fallback Sort arm swallowed the Sort without marking it. This is the conservative reading, and the one consumer that loses anything (the index-nested-loop seek) already refuses a LIMIT at its peel gate. Fixed inline: I extended the accepted-tradeoff NOTE in `fallbackIndexSupports` to say so, because it listed only the aliased case as taking the absorb path.

**Tripwire, parked as a `NOTE:` on `tryLimitedSortAbsorb`.** A module that implements both `supports()` and `getBestAccessPlan` now gets the index-style absorb for `order by … limit n` with the Sort directly on the Retrieve, where it used to be offered the Sort through `supports()`. No in-tree module implements both (only the test `TestQueryModule` has `supports()`, and it has no `getBestAccessPlan`).

**Tripwire already parked by the implementer.** A chain Filter re-checks a predicate the seek already claimed on the IndexedDB profile (`FILTER b = 1` over the `ix_bc` seek). The NOTE at the no-clobber guard in `fallbackIndexSupports` is accurate. Left as is.

**Existing ticket extended: `bug-isolation-forwards-plan-time-limit-to-underlying` (backlog).** That ticket predicted this route would widen the isolation-layer hazard. I appended a paragraph saying the route has landed, with an example query. No new ticket.

**Tests: kept the one added, no new ones.** The new end-to-end case pins a named contract (a user's constant LIMIT reaches the module) on logic with real branching. The unlimited-plan assertion stops it from passing for the wrong reason. The probe I ran overlaps existing coverage of row correctness and is not worth its run time as a permanent spec, so I deleted it.

**Type safety, error handling, resource cleanup, size: no findings.** The new helpers are small and typed. `absorbed as RelationalPlanNode` matches the existing helper's return. There are no resources or exceptions to handle. `rule-grow-retrieve.ts` is 1056 lines (`wc -l`), up about 60 lines. It was already large before this change, and the new code sits next to the helper it calls.

**Docs: checked, accurate.** `docs/optimizer-retrieve.md` (three entry points, `orderingLoadBearing` bullet) and `docs/module-authoring.md` (limit-licence paragraph) match the behaviour. The follow-on `sort-absorb-runtime-limit-choice` that they cite exists in `implement/`. A grep for the old "user LIMIT is never seen" wording found no stale text.

**Validation:** `yarn workspace @quereus/quereus run lint` (exit 0), `yarn workspace @quereus/quereus run test` (11144 passing, 26 pending), `yarn workspace @quereus/store run test` (2018 passing). `yarn test:store` (the LevelDB logic re-run) was not run.
