description: Review the demand-gated optimizer rule that prunes an UNUSED outer-join `exists … as` existence flag from a JoinNode, re-enabling join-elimination / physical-join selection. Pure optimization (no correctness defect today). Build + full quereus suite + lint all green.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (new), packages/quereus/src/planner/rules/join/rule-join-elimination.ts (helpers exported), packages/quereus/src/planner/optimizer.ts (registration), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (new), packages/quereus/test/property.spec.ts (+2 tests in the "Outer-join existence column" block), docs/view-updateability.md, docs/optimizer.md
----

## What landed

A new Structural optimizer rule, **`ruleJoinExistencePruning`** (id
`join-existence-pruning`, `PlanNodeType.Project`, `phase: 'rewrite'`, priority
22, `sideEffectMode: 'safe'`), that drops an outer-join `exists … as` match-flag
column from a `JoinNode` when **no ancestor demands its output attribute id**.
When the last flag is dropped, `existence` becomes `undefined`,
`hasExistenceColumns` flips `false`, and the five flag-guarded join rules
(`join-elimination`, `fanout-lookup-join`, `join-physical-selection`,
`monotonic-merge-join`, `lateral-top1-asof`) re-enable automatically on the
flag-free join — in the same Structural pass for the first two, and in
PostOptimization / top-down descent for the rest.

### Implementation specifics

- **DRY demand analysis.** Rather than copy `ruleJoinElimination`'s chain walk,
  the four helpers (`collectAttrIds`, `walkChain`, `rebuildChain`,
  `rebuildProject`) and the two types (`ChainEntry`, `ChainWalkResult`) were
  **`export`ed** from `rule-join-elimination.ts` (previously module-private) and
  imported by the new rule. No logic was duplicated; the existing
  join-elimination tests confirm the helpers are unchanged behaviorally (full
  suite green).
- **The rule body** (`rule-join-existence-pruning.ts:66-99`): anchor on a
  `ProjectNode`, collect demanded attr ids from its projections, `walkChain` the
  `Filter`/`Sort`/`LimitOffset`/`Distinct`/`Alias` pass-through chain to the first
  `JoinNode`, filter `join.existence` to specs whose `attrId ∈ demanded`, and (if
  any were dropped) rebuild the `JoinNode` + chain + Project. `kept.length === 0`
  ⇒ `existence: undefined`.
- **Registration** (`optimizer.ts`, ~line 356): placed in the Structural pass
  *registration order* after `projection-pruning` (19) / `predicate-pushdown`
  (20) / `scalar-cse` (22) and **before** `fanout-lookup-join` (23) /
  `join-elimination` (24). Registration order — not the numeric `priority` — is
  what the PassManager honors (`pass.ts applyPassRules` iterates `pass.rules` in
  push order); the priority value is documentary/consistency only. This ordering
  is what lets a freshly-pruned `Project` thread through fanout + elimination in
  the same `applyRules` while-loop on the same node.

## Soundness arguments the reviewer should pressure-test

1. **Project anchor = complete demand check.** A node above the anchoring Project
   can only reference attr ids the Project *outputs*, and the Project outputs
   exactly its projections' ids. So a flag absent from `demanded` (projections +
   chain Filter/Sort refs) is provably dead. When the join is *not* reachable via
   a clean Project+chain (under Aggregate, a second Project, another Join, a
   scalar subquery), `walkChain` returns `null`, the rule no-ops, and the flag is
   retained — correct, just unoptimized.
2. **Middle-flag drop is runtime-safe.** Runtime column resolution is by
   attribute id (`emitColumnReference` → `resolveAttribute(rctx, attrId, …)` over
   a `RowDescriptor` rebuilt from `getAttributes()`), not the build-time
   `columnIndex`. The join emitter (`runtime/emit/join.ts`) builds the flag rows
   from `plan.existence` in array order and `buildJoinAttributes` appends flag
   attributes in the same order, so kept-flag positions stay consistent after a
   drop. **Verified by the mixed multi-flag test** (drop the earlier of two flags,
   assert the later reads correctly via `db.eval`).
3. **Write half is safe by construction.** A writable existence column is always
   SELECTed by its view's projection, so every UPDATE/INSERT-through-view path
   marks the flag demanded ⇒ retained. The unused case arises only when the flag
   is never selected (pure read-side dead column). No statement-level context in
   the rule. **Verified**: the property-spec write-half PutGet families still pass,
   plus a new test asserts a flag-selecting view keeps its flag in the optimized
   plan and routes `update … set hasP = false` unchanged.
4. **`sideEffectMode: 'safe'`** — drops only a derived read-only `{true,false}`
   column; both join sides survive verbatim, so no write can be skipped/reordered
   (contrast `join-elimination`'s `'aware'`, which drops a whole side).

## Tests & validation

- **New optimizer spec** `test/optimizer/rule-join-existence-pruning.spec.ts`
  (13 tests, all green). Uses `query_plan(?)` (which runs the full optimizer) —
  the `JoinNode`'s `getLogicalAttributes().existence` is serialized into the plan
  `properties` column, so the tests assert *exactly which flags survive*, not just
  op counts. Cases:
  - **prune → eliminate**: unused flag on an FK→PK LEFT join ⇒ `joinCount == 0`;
    the same query selecting the flag keeps a flag-bearing logical `JOIN`.
  - **prune → physical selection**: unused flag on a non-eliminable equi-join (no
    FK, both data sides referenced) ⇒ a `HASHJOIN`/`MERGEJOIN` appears; selecting
    the flag keeps the logical nested-loop `JOIN`.
  - **retained** when the flag is in the projection / a WHERE filter / an ORDER BY
    / `select *` — each asserts `existence` survives *and* values are correct.
  - **mixed multi-flag**: two `exists right` flags, only the later selected ⇒
    `existence == ['exists right as hasB']` and `hasB` values correct.
  - **result equality**: every prune case is byte-identical to the
    `disabledRules: {'join-existence-pruning'}` baseline from the same db.
  - **no-op when disabled**.
- **property.spec.ts** "Outer-join existence column" block: +2 tests (read
  agreement preserved under pruning; write half intact). The existing read-half
  (read agreement / clean-boolean / FD `key→flag` / lineage / column_info) and
  write-half (`write drives insert/delete`) tests stay green.
- **Full suite**: `yarn workspace @quereus/quereus test` ⇒ **4878 passing, 9
  pending, 0 failing**. **Lint**: `yarn workspace @quereus/quereus run lint` ⇒
  clean. **Typecheck** (`tsc --noEmit`): clean.

## Honest gaps / things to probe

- **The "prune → physical selection" test** asserts `HASHJOIN || MERGEJOIN`
  appears for a small memory-table fixture; it depends on the cost model picking
  a physical variant over nested-loop (same assumption as the established
  `test/plan/join-selection.spec.ts`). A cost-heuristic change could require
  re-tuning that assertion — it is a *floor* ("pruning unblocks physical
  selection"), not a guarantee of a specific algorithm.
- **The mixed multi-flag test uses two `exists right` flags on one LEFT join**
  (both track the same right-side match — redundant but valid syntax). A more
  "natural" two-sided two-flag case needs a FULL join, whose nested-loop emitter
  currently throws `FULL JOIN is not supported yet` at runtime — so it could not
  be exercised via `db.eval`. The redundant-flag construction still genuinely
  exercises the middle-drop attr-id-resolution path; reviewer should confirm
  they're satisfied this covers the regression-prone case.
- **Shared (DAG) flag-bearing join**: pruning under one Project that doesn't
  demand the flag rebuilds a *new* join for that Project; a sibling Project that
  *does* demand the flag keeps its own (PlanNode immutability makes this safe).
  This is *not* directly tested — it relies on the optimizer's per-node rewrite
  immutability, same as `join-elimination`. Worth a glance if the reviewer can
  construct a CTE/view shape that shares one flag-bearing join across two consumers
  with divergent demand.
- **Deferred stretch work** (documented in the ticket's "Out of scope", now
  parked): aggregate-anchored pruning (mirror `ruleJoinEliminationUnderAggregate`)
  and semijoin/anti-semijoin recovery for a flag used *only* as a boolean
  `where hasP` probe. Both are no-correctness-impact optimizations. Captured in
  `tickets/backlog/existence-flag-pruning-followups.md`.

## Usage

No surface/API change. Purely a plan-quality improvement: any query/view with an
`exists [<side>] as <name>` clause whose flag column is never read now gets the
join eliminated or physically selected as if the flag weren't there. Observable
via `query_plan(...)` (`existence` disappears from the `JoinNode` properties; join
ops drop or pick up hash/merge). Disable with
`tuning.disabledRules = new Set(['join-existence-pruning'])`.
