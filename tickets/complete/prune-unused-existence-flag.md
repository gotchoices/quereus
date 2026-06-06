description: Demand-gated optimizer rule `ruleJoinExistencePruning` (id `join-existence-pruning`) that drops an UNUSED outer-join `exists … as` existence flag from a JoinNode, re-enabling join-elimination / physical-join selection on the now flag-free join. Pure optimization (no correctness defect). Reviewed: build + full quereus suite + lint all green; 3 regression tests added.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts (exported helpers), packages/quereus/src/planner/optimizer.ts (registration), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, docs/view-updateability.md
----

## What landed

A new Structural optimizer rule, `ruleJoinExistencePruning` (`PlanNodeType.Project`,
`phase: 'rewrite'`, `sideEffectMode: 'safe'`), registered in the Structural pass
after projection-pruning / predicate-pushdown / scalar-cse and before
fanout-lookup-join and join-elimination. It anchors on a `ProjectNode`, collects
demanded attribute ids from the projections, `walkChain`s the
Filter/Sort/LimitOffset/Distinct/Alias pass-through chain to the first
`JoinNode`, and rebuilds that join without any `ExistenceColumnSpec` whose output
attribute id is absent from the demanded set. When the last spec is dropped,
`existence` becomes `undefined`, `hasExistenceColumns` flips `false`, and the five
flag-guarded join rules (`join-elimination`, `fanout-lookup-join`,
`join-physical-selection`, `monotonic-merge-join`, `lateral-top1-asof`) re-enable
on the flag-free join. The four chain helpers (`collectAttrIds`, `walkChain`,
`rebuildChain`, `rebuildProject`) and two types were exported from
`rule-join-elimination.ts` and reused verbatim (no logic duplicated).

Deferred follow-ons (aggregate-anchored pruning; semijoin/anti-semijoin recovery
for a flag used only as a boolean `where hasP` probe) are parked in
`tickets/backlog/existence-flag-pruning-followups.md`.

## Review findings

Reviewed the implement diff (commit `0cac5a72`) with fresh eyes against the
source it touches and the source it *should* have touched, then ran lint + tsc +
full suite.

**Checked — correctness / soundness:**
- **Demand-completeness of the Project anchor.** Confirmed `ProjectNode.getAttributes()`
  emits exactly one attribute per projection in *both* `preserveInputColumns`
  branches — the flag name is a red herring; the Project never passes input
  columns through implicitly. So an ancestor can only reference attr ids the
  Project outputs, and a flag absent from `demanded` is provably dead. **Sound.**
- **Demand recursion into subqueries.** `collectAttrIds` recurses
  `getChildren()`, so a flag referenced only inside a correlated scalar subquery
  is still seen as demanded. **Verified by a new test** (was *not* covered before).
- **Middle-flag-drop runtime safety.** Verified the emitter (`runtime/emit/join.ts`)
  builds flag rows from `plan.existence` in array order and `buildJoinAttributes`
  appends flag attributes in the same order; resolution is by attr id over a
  `RowDescriptor` rebuilt from `getAttributes()`. Dropping a non-edge flag keeps
  kept-flag slots consistent. **Verified by a new 3-flag middle-keep test.**
- **`sideEffectMode: 'safe'` is correct.** The rewrite reuses `join.left`/`join.right`
  verbatim and drops only derived flag *metadata* (not a subtree); chain/Project
  wrappers reuse their scalar children verbatim — nothing moved, dropped, merged,
  or duplicated, which is exactly the registry's `'safe'` contract.
- **Registration-order claim.** Verified `pass.ts` iterates `pass.rules` in push
  order (line 520); `priority` is *not* used for intra-pass ordering (only passes
  themselves sort, by `order`). The doc/comment claim that push order — not the
  numeric priority — governs is accurate, and existence-pruning is genuinely
  pushed before fanout-lookup-join and join-elimination. (Note: ordering is a
  same-pass *performance* nicety, not a correctness dependency — the Structural
  fixpoint loop would converge regardless.)
- **All five guards present.** Confirmed each of the five named rules carries
  `if (node.hasExistenceColumns) return null`.
- **All `.existence` consumers are consistent** after a drop: JoinNode internals
  (`computePhysical`/`getType`/`getAttributes`/`withChildren`/`existenceSites`/
  `withFlagDomains`), the emitter, and the five guards all derive from whatever
  array is present, so a pruned join is coherent end-to-end.
- **Write-half safety.** A writable flag is always SELECTed by its view's Project
  ⇒ demanded ⇒ retained; pruning only removes pure read-side dead flags.
  **Verified** by the property-spec write-half test (retain + route `update … set
  hasP = false`).
- **Termination.** Re-running the rule on its own output is a no-op (kept flags
  are all demanded; `kept.length === existence.length` ⇒ return null), so no
  rewrite loop.

**Found / done:**
- **Minor — coverage gaps (fixed inline).** The handoff flagged the
  divergent-demand DAG case as untested, and the correlated-subquery demand path
  was not exercised at all. Added 3 regression tests to
  `rule-join-existence-pruning.spec.ts` (`demand detection edge cases`): (1) flag
  referenced only inside a correlated scalar subquery is retained and reads
  correctly; (2) three flags, only the middle selected — both ends pruned, middle
  resolves correctly; (3) divergent demand across two consumers of one
  flag-bearing CTE join. All pass.
- **No major findings** ⇒ no new fix/plan tickets filed. The two deferred
  stretch items already have a backlog ticket.

**Empty categories (explicit):**
- *Correctness bugs:* none — the demand gate is the same analysis join-elimination
  already relies on, applied to a strictly narrower (drop a derived read-only
  column vs. drop a whole side) decision.
- *Docs:* no additional updates needed. `optimizer.md` and `view-updateability.md`
  were correctly updated by the implementer; `sql.md`'s existence-columns section
  is user-facing grammar/semantics and makes no (now-stale) optimizer claim, so it
  required no change. The `set-op membership` note in `view-updateability.md`
  correctly records that the set-op sibling prune remains deferred.
- *Resource cleanup / error handling / type safety:* nothing to flag — the rule is
  a pure function returning a new immutable plan node; no I/O, no `any`, the one
  `existence!` assertion is guarded by `hasExistenceColumns`.

## Tests & validation (re-run during review)

- `rule-join-existence-pruning.spec.ts`: **16 passing** (13 original + 3 added).
- Full suite `yarn workspace @quereus/quereus test`: **4881 passing, 9 pending, 0
  failing**.
- Lint (`yarn workspace @quereus/quereus run lint`): clean.
- Typecheck (`tsc --noEmit`): clean.

## Usage

No surface/API change. Any query/view with an `exists [<side>] as <name>` clause
whose flag column is never read now gets the join eliminated or physically
selected as if the flag weren't there. Observable via `query_plan(...)`
(`existence` disappears from the `JoinNode` properties; join ops drop or pick up
hash/merge). Disable with `tuning.disabledRules = new Set(['join-existence-pruning'])`.
