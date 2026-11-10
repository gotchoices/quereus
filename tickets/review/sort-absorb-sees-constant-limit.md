description: When a query sorts and then takes a fixed number of rows ("order by date limit 20"), the storage backend is now told how many rows are wanted, so a backend with slow random reads can choose to read 20 rows through an index instead of scanning and sorting the whole table.
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # new LimitOffset arm at the top of ruleGrowRetrieve; tryLimitedSortAbsorb / constantRowsWanted / sortUnderLimit after trySortAbsorbViaIndexOrdering; NOTE at the no-clobber guard in fallbackIndexSupports
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # comment at the rowsWanted call
  - packages/quereus-store/src/common/store-module-access-plan.ts  # NOTE on chooseOrderingPlan
  - packages/quereus-store/test/plan-time-limit.spec.ts  # new end-to-end case
  - docs/optimizer-retrieve.md  # "three entry points" list
  - docs/module-authoring.md  # "limit is a licence" paragraph
----
# A constant LIMIT above a Sort reaches the module

## What changed

`ruleGrowRetrieve`, when offered a `LimitOffsetNode`, now first calls `tryLimitedSortAbsorb`:

- `constantRowsWanted` reads LIMIT and OFFSET with `constantNumber` (absent OFFSET = 0), `Math.trunc`s both, and returns nothing if either is not a plan-time constant (placeholder limits are the follow-on `sort-absorb-runtime-limit-choice`).
- `sortUnderLimit` walks down from the LimitOffset's source through `ProjectNode` / `AliasNode` only, and must land on a `SortNode`. A Filter or Distinct in between stops the walk.
- It calls `trySortAbsorbViaIndexOrdering(sort, context, { limit, offset })`. On success it rebuilds LimitOffset → … → (absorbed chain) with `rebuildChain` from `rules/shared/access-leaf.ts`. The LimitOffset is kept above and executes; it is never swallowed.
- On decline it falls through to the existing handling unchanged (the `fallbackIndexSupports` LimitOffset arm for a LimitOffset directly on a Retrieve; otherwise null). The Sort visit later in the pass still makes its limit-free attempt.

No registration change: `LimitOffset` was already in `GROW_RETRIEVE_NODE_TYPES`, and the pass is top-down, so the limit-aware attempt runs before the Sort visit.

Comments updated: `trySortAbsorbViaIndexOrdering` doc ("three entry points"), the minmax comment, the store `chooseOrderingPlan` NOTE. Docs updated: `docs/optimizer-retrieve.md` (three entry points as a list), `docs/module-authoring.md` (a user-written constant LIMIT / OFFSET above an ORDER BY now arrives; a placeholder does not).

## Observed plans (scratch probe, 200 rows, `ix_bc on t(b, c)`, `b = 1` selects 100)

IndexedDB profile (`pointRead` 3.0):
- `… where b = 1 order by c` → SORT over FILTER over `_primary_` scan (unchanged, the seek is vetoed).
- `… where b = 1 order by c limit 20` → LIMITOFFSET → FILTER `b = 1` → INDEXSEEK `ix_bc` ORDER BY c. Was SORT + scan before.
- `… limit 5 offset 3`, and the same with `select id, c` (Project in between) → same shape, right rows (ids 7, 9, 11, 13, 15).
- `… where b = 1 and u > 2 order by c limit 5` (`u` unindexed) → unchanged: SORT over scan, because `truncationIsSafe` strips the limit.

Parity profile (default): every query above planned the same as before.

## Tests

- `plan-time-limit.spec.ts` › end to end › "a constant LIMIT the user wrote above an order by reaches the module" — IndexedDB profile, 200-row fixture. Asserts the unlimited query still plans a SORT (so the fixture is sized so the limit matters), the `limit 20` query plans an `ix_bc` access with no SORT, and its rows equal the first 20 of the unsorted `where b = 1` result after sorting by `c` in JS. Confirmed it fails with the new arm disabled (no `ix_bc` in the plan) and passes with it.
- No descending variant: `order by c desc` goes through the same engine code. The store's direction handling is already covered by the existing `max` end-to-end case.
- No memory-backend test: the plan cannot change there.

Validation run: `yarn workspace @quereus/quereus run lint` (clean), `yarn workspace @quereus/quereus run test` (11144 passing, 26 pending, 0 failing), `yarn workspace @quereus/store run test` (2018 passing), `yarn workspace @quereus/isolation run test` (453 passing). `yarn test:store` (the quereus logic suite on LevelDB) was **not** run.

## Known gaps / things for the reviewer to check

- **Redundant Filter on the IndexedDB plan.** After the absorb, the chain Filter (`b = 1`) re-grows over the equipped Retrieve *without* the limit. The expensive-`pointRead` module answers unordered, and the no-clobber guard in `fallbackIndexSupports` declines, so `FILTER b = 1` stays above the seek and re-checks a predicate the seek already enforces. The result is correct, and the extra cost is one predicate evaluation per row the LIMIT pulls. The min/max boundary read already produced exactly this (`select min(c) from t where b = 1` shows the same FILTER today). Parked as a `NOTE:` tripwire at the no-clobber guard; no ticket.
- **Sort directly on a Retrieve** (`select * from t order by c limit 20`, no Filter/Project/Alias) used to go through `fallbackIndexSupports`'s Sort arm, which swallows the Sort and does *not* set `orderingLoadBearing`. When the limit-aware absorb succeeds, it now goes through `trySortAbsorbViaIndexOrdering`, which *does* set `orderingLoadBearing: true`. The accepted-tradeoff NOTE in `fallbackIndexSupports` is about `join (select * from big order by v) z` without a LIMIT, so it is not affected, and a LIMIT there is already refused by the index-nested-loop peel gate. The full suite showed no plan changes, but the reviewer may want to confirm that nothing reading `orderingLoadBearing` (monotonic-limit-pushdown, the key-set seek rules) now declines where it used to fire.
- **A Retrieve that already carries an index-style context under the Sort.** `trySortAbsorbViaIndexOrdering` replaces the context wholesale, and its residual is built only from the constraints it re-extracts, not from the committed `residualPredicate`. In the top-down pass the LimitOffset is visited before anything below it, so it sees the same tree the Sort visit would, and minmax already routes a Sort-directly-on-Retrieve through the same helper. I found no new way to reach an already-equipped Retrieve, but this was checked by reading the code, not by a test.
- **Explicit OFFSET over an equipped Retrieve** (identity `select *`): the new LimitOffset inherits the `grow-retrieve-LimitOffset` applied mark, so it is not re-offered to the swallowing LimitOffset arm in this pass. Probe results with `limit 5 offset 3` were correct on both profiles.
