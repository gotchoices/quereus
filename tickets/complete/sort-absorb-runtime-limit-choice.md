description: A sorted query whose row limit is a placeholder filled in at run time ("order by date limit ?", the usual paginated list) now plans both the index read and the scan-and-sort, and picks between them on each execution once the actual limit is known.
prereq: sort-absorb-sees-constant-limit
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/nodes/limit-choice-node.ts
  - packages/quereus/src/runtime/emit/limit-choice.ts
  - packages/quereus/src/planner/rules/shared/evaluate-twice.ts
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts
  - packages/quereus/src/planner/analysis/required-columns.ts
  - packages/quereus/src/planner/analysis/scalar-subqueries.ts
  - packages/quereus/src/planner/cache/materialization-advisory.ts
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus-store/src/common/store-module-access-plan.ts
  - packages/quereus-store/test/plan-time-limit.spec.ts
  - docs/optimizer-retrieve.md
  - docs/optimizer-fd.md
  - docs/module-authoring.md
----
# A placeholder LIMIT above a Sort: decide at run time

For `select … where owner = ? order by date desc limit ?` on a backend with expensive row reads (IndexedDB cost profile), the planner now builds:

```
LimitOffset(limit ?, offset)
└─ LimitChoice  "ORDERED WHEN LIMIT + OFFSET <= N"   (same limit/offset expression instances)
   ├─ ordered: chain → IndexSeek, plan priced at limit N, no Sort
   └─ sorted:  original Sort → chain → scan
```

`tryRuntimeLimitChoice` (in `rule-grow-retrieve.ts`, reached from the LimitOffset visit when the LIMIT or OFFSET is not a constant) finds `N` as the largest bound at which the module still returns an ordered plan: it doubles from 2 up to a cap of `2 ** 30`, then bisects. The emitter evaluates LIMIT/OFFSET through the shared `resolveWindow` and runs `ordered` only when `limit + offset <= N`, which is what lets the module truncate at `N`. Both branches are emitted as on-demand sub-programs, so the branch not taken opens nothing. The rule declines (leaving today's plan) on parity backends (where the limit-free plan is already ordered), when even `limit 1` is unordered, when the LIMIT/OFFSET is not safe to evaluate twice, or when the shared subtree writes, holds a subquery, or has a chain node that mints an attribute id. The materialization advisory gained a rule that never wraps a `TableReference`, which both branches' access nodes share. The design is documented in `docs/optimizer-retrieve.md` § "A placeholder LIMIT: choosing at run time".

Landed in `ticket(implement): sort-absorb-runtime-limit-choice` and the resume commit before it; full change: `git diff ff14e0f14 -- packages docs`.

## Review findings

Read the full diff against `ff14e0f14` before the handoff, then ran edge cases with a throwaway store spec (IndexedDB profile, 200 rows, `ix_bc on t(b, c desc)`, `validate_plan` on). The spec has been deleted.

**Correctness: checked, no defects found.**
- `limit ? offset ?` across the threshold (N = 60): `(20,0)`, `(20,50)` (ordered), `(20,90)`, `(5,98)` (tail pages), `(61,0)` (sorted). All returned the right row counts and order.
- Computed select-list column above the Sort (`c + 1 as x`): gets LimitChoice, correct rows at 3 and 150. A computed projection below the Sort declines as the handoff says, and the plan is unchanged.
- Derived table under a join, `count(*)` over the limited subquery, and a CTE referenced twice under `union all` (two LimitChoice instances, one per CTE body): all plan LimitChoice, pass the validator, and return correct rows on both sides of the threshold.
- Correlated limit (`limit o.n` inside a scalar subquery per outer row, with n = 3, 70 and 0): plans LimitChoice and returns 3, 70 and 0. So 70 took the sorted branch and 0 short-circuited in the LimitOffset above.
- Unclaimed filter (`and u > 10`): declines as designed and keeps Sort over scan.
- Licence: the emitter's `limit + offset <= orderedUpTo` matches the ordered plan's request `limit: N, offset: 0`. `probeAccessPlan` strips the bound whenever truncation is unsafe, so a module can never stop early under a residual filter. `LimitOffset` returns before pulling on `limit 0`, so LimitChoice never sees it.
- Rule termination: the rewritten LimitOffset's source no longer reaches a Sort through Project/Alias, so the visit cannot fire twice. The Sort left in the `sorted` branch is revisited by the Sort visit, which declines because the limit-free plan is unordered (the same check the rule made).

**Interactions: checked.** I reviewed every rule that matches `LimitOffsetNode` or `PlanNodeType.LimitOffset`. `rule-lateral-top1-asof` and `rule-empty-relation-folding` act only on constant limits, which never produce a LimitChoice. The view-lineage and mutation pass-through lists (`mutation/propagate.ts`, `lens-prover.ts`) walk view bodies, and a Sort under LIMIT has no update lineage anyway. The node doc comment's argument for the other rules holds.

**Physical properties: checked.** `computePhysical` forwards everything from `sorted` except `updateLineage` and `attributeDefaults`. `SortNode` and `LimitOffsetNode` don't thread those either, so nothing is lost.

**Docs: two minor gaps, both fixed.** `docs/optimizer-fd.md`'s propagation table now lists `LimitChoiceNode` with the pass-through operators. The caller list in `hasRelationalDescendant`'s doc (`analysis/scalar-subqueries.ts`) was stale, and now names its two new callers. `optimizer-retrieve.md`, `module-authoring.md` and the store `NOTE` were already accurate.

**Size and hygiene: tripwire.** `rule-grow-retrieve.ts` grew from 1057 to about 1250 lines (`wc -l`, at `ff14e0f14` and now). It is still coherent, but a split would have to move the shared probe helpers too, so I left the code as it is. A `NOTE:` above `tryRuntimeLimitChoice` names the split point. The comments elsewhere in the diff state reasons and constraints rather than narrating the code.

**Tests: kept as is.** The one new spec reproduces the GitHub #36 shape and pins both branches (row equality plus `rowsScanned`) without asserting the cost-dependent threshold. It meets the bar. I added no tests, because the edge cases above found no defects.

**Already-decided items: not re-filed.** The cost over-count (a `NOTE:` on the node), the probe-count tripwire (a `NOTE:` at `largestOrderedBound`), and isolation-layer limit forwarding (backlog `bug-isolation-forwards-plan-time-limit-to-underlying`) all have homes already.

**Side observation, not this change:** `query_plan('… limit ? + 1')` fails with "LIMIT expression may be NULL" because an unbound parameter is typed nullable, but executing the same statement works. That behaviour belongs to the row-count prepare check, not to this ticket. No ticket filed; noted here only.

**Validation:** `eslint 'src/**/*.ts' 'test/**/*.ts'` and `tsc -p tsconfig.test.json --noEmit` in `packages/quereus` are clean. `yarn workspace @quereus/quereus run test`: 11144 passing, 26 pending. `yarn workspace @quereus/store run test`: 2019 passing.
