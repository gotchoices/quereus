description: A sorted query whose row limit is a placeholder filled in at run time ("order by date limit ?", the usual paginated list) now plans both the index read and the scan-and-sort, and picks between them on each execution once the actual limit is known. Review the new plan node, the rule that builds it, and the run-time choice.
prereq: sort-absorb-sees-constant-limit
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # prepareSortAbsorb / orderedPlanFor / buildAbsorbed split; tryRuntimeLimitChoice, branchesCanShare, largestOrderedBound, bisectOrderedBound
  - packages/quereus/src/planner/nodes/limit-choice-node.ts  # new LimitChoiceNode
  - packages/quereus/src/runtime/emit/limit-choice.ts  # new emitter
  - packages/quereus/src/planner/rules/shared/evaluate-twice.ts  # safeToEvaluateTwice, moved out of rule-key-set-seek-row-bound
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts  # now imports the shared helper
  - packages/quereus/src/planner/analysis/required-columns.ts  # LimitChoice passes demand to both branches
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # new Rule 2b: never wrap a TableReference
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # comment only
  - packages/quereus-store/src/common/store-module-access-plan.ts  # NOTE on chooseOrderingPlan, comment only
  - packages/quereus-store/test/plan-time-limit.spec.ts  # end-to-end test
  - docs/optimizer-retrieve.md  # new subsection "A placeholder LIMIT: choosing at run time"
  - docs/module-authoring.md  # probe list; the limit licence
----
# A placeholder LIMIT above a Sort: decide at run time (review handoff)

Most of this work landed in commit `0526dadbb` (the runner's "timed out … added resume note" commit, which swept up the prior run's finished but unverified edits). This run verified it, fixed one comment wrap, and turned on plan validation in the end-to-end test. To see the whole change: `git diff ff14e0f14 -- packages docs`.

## What was built

For `select … where owner = ? order by date desc limit ?` on a backend with expensive row reads (IndexedDB profile), the plan is now:

```
LimitOffset(limit ?, offset)
└─ LimitChoice  "ORDERED WHEN LIMIT + OFFSET <= N"   (same limit/offset expression instances)
   ├─ ordered: chain → IndexSeek on (owner, date), plan priced at limit N, no Sort
   └─ sorted:  original Sort → chain → scan
```

- **Rule** (`tryRuntimeLimitChoice` in `rule-grow-retrieve.ts`, reached from the LimitOffset arm when the LIMIT or OFFSET is not a constant). It declines when: there is no LIMIT; the LIMIT or OFFSET fails `safeToEvaluateTwice`; the subtree below the Sort writes or holds a subquery; a chain node mints an attribute id; the limit-free plan already delivers the ordering (parity backends, where the Sort visit absorbs as before); or the plan at `limit 1` does not deliver it.
- **Threshold search** (`largestOrderedBound`): doubling from 2 up to a cap of `2 ** 30`, then bisecting. `orderedUpTo` is the largest bound at which the module still returns an ordered plan, and that plan is the one the `ordered` branch uses. `NOTE:` at the search about the probe count (about `2·log2(rows) + 2`).
- **Node** (`LimitChoiceNode`): children `[ordered, sorted, limit, offset?]`. Attributes, type, ordering, estimates and physical properties come from `sorted`. The constructor (and so `withChildren`) throws `INTERNAL` if the branches' attribute ids differ. Self-cost 0.01; the total counts both branches (`NOTE:` on the constructor). Its doc comment explains why the rules that look below a LimitOffset lose nothing.
- **Emitter**: both branches go through `emitCallFromPlan`, so the branch not taken opens nothing. LIMIT/OFFSET are resolved through the shared `resolveWindow`. It takes `ordered` when `limit + offset <= orderedUpTo` (so `limit 0` takes it); the licence-invariant comment is at that comparison.
- **Prepare/build split**: `trySortAbsorbViaIndexOrdering` is now `prepareSortAbsorb` + `orderedPlanFor` + `buildAbsorbed`, with the old export kept as their composition. Its two existing callers did not change.

### Changes the ticket did not anticipate

- **Materialization advisory, new Rule 2b** (`planner/cache/materialization-advisory.ts`): a `TableReference` is never recommended for caching. Both branches' access nodes share one `TableReference`, so the advisory saw "multiple parents" and tried to wrap it in a cache. That wrap can never land, because access nodes accept only a `TableReference` child; it logged a `withChildren failed` warning and gave up. The new rule skips that. It applies to every plan, not just this node, but a `TableReference` has no emitter, so it is never iterated and nothing else could have been cached there.
- **No plan-validator change was needed.** `computeAttributeProvenance` treats ids coming out of a node's direct relational children as forwarded, so LimitChoice forwarding `sorted`'s ids is not a duplicate origin, and both access nodes forward the shared `TableReference`'s ids. Cost additivity is computed generically in `PlanNode.getTotalCost`, so the node is additive by construction. The validator's duplicate-origin check is the reason for the attribute-minting decline (next section).

## Known gaps and limits (please weigh)

- **Computed projection below the Sort declines.** In `select * from (select id, c, id + 1 as x from t where b = 1) s order by c desc limit ?`, the Project that computes `x` sits under the Sort. The rebuilt ordered chain would originate `x`'s attribute id a second time, which the validator rejects, so `branchesCanShare` declines and today's plan stays. Computed columns in the select list itself (`select id, c + 1 as x … order by c desc limit ?`) sit **above** the Sort and do get the node; I checked this with a throwaway probe. To lift the decline, either the validator would have to accept duplicate origins inside alternative branches, or the chain would have to be re-minted. I did neither.
- **Probe cost was not timed.** The count (about 40 probes for a million rows) is computed from the search, not measured. The search runs only on non-parity backends whose limit-free plan is unordered but whose `limit 1` plan is ordered.
- **Cost over-count** is accepted per the ticket (`NOTE:` on the node).
- **Isolation layer**: the ordered branch's request carries `limit: orderedUpTo` and is subject to backlog `bug-isolation-forwards-plan-time-limit-to-underlying`. Out of scope.
- Covered **by inspection only**: correlated limit (same outer row, same precedent as the key-set node); writing or non-deterministic limit (declined by `safeToEvaluateTwice`); unclaimed filter below the Sort (the `limit 1` probe is unordered, so the rule declines).

## Observed behaviour (fixture: 200 rows, `ix_bc on t(b, c desc)`, 100 rows with `b = 1`, IndexedDB profile)

The prior run's probe found `orderedUpTo = 60` for `select * from t where b = 1 order by c desc limit ?`:

| limit | rows | `rowsScanned` | branch |
|---|---|---|---|
| 0, 20, 59, 60 | = limit | = limit | ordered |
| 61, 100, 150 | min(limit, 100) | 200 | sorted |

`limit 20 offset ?`: offset 0 → scanned 20 and offset 30 → scanned 50 (ordered); offset 90 → scanned 200 (sorted). `where b = ?` (the exact GitHub #36 shape) and `limit ? offset ?` both plan a LimitChoice.

## Test added

- `packages/quereus-store/test/plan-time-limit.spec.ts` › "a placeholder LIMIT picks the ordered read or the sort when it runs". It prepares the query once with `validate_plan` on and asserts that `query_plan` shows `LIMITCHOICE`. It then runs with `? = 20` (rows equal a test-side sort, `rowsScanned` = 20) and with `? = 150` (all 100 matching rows, `rowsScanned` ≥ 100, so the sorted branch ran). It reproduces the issue and pins both sides of the branch. The exact threshold is deliberately not asserted, because it depends on the store's cost constants.

## Validation run

- `eslint 'src/**/*.ts' 'test/**/*.ts'` in `packages/quereus`: clean. `tsc -p tsconfig.test.json --noEmit`: clean (1042 files).
- `yarn workspace @quereus/quereus run test`: 11144 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/store run test`: 2019 passing.
- Note for whoever reruns lint: `yarn … run lint` prints nothing for its first ~40 s of eslint, and the previous attempt was killed by the runner's 10-minute idle timer during a second, slow lint run. Running eslint and tsc as separate commands finished in about 40 s and 4 s.
