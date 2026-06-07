description: Aggregate-anchored variant of `semijoin-existence-recovery`. Added `ruleSemijoinExistenceRecoveryUnderAggregate` — a second entrypoint anchored on `AggregateNode` that recovers a semi/anti join from a probe-only `left join … exists right as <flag>` sitting under a bare `count(*)` / `group by` with no enclosing Project (e.g. `select count(*) from child c left join parent p on … exists right as hasP where hasP`). Shares ALL probe-detection + chain-rewrite machinery with the Project entrypoint; only the demand seed (group-by + aggregate exprs) and rebuild epilogue (`AggregateNode` with `preserveAttributeIds`) differ. Mirrors how `ruleJoinExistencePruningUnderAggregate` / `ruleJoinEliminationUnderAggregate` extended their Project siblings.
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, docs/optimizer.md
----

## What shipped

A second entrypoint, `ruleSemijoinExistenceRecoveryUnderAggregate`
(`rule-semijoin-existence-recovery.ts`), registered as `semijoin-existence-recovery-aggregate`
(`optimizer.ts`, `nodeType: Aggregate`, `priority: 23`, `sideEffectMode: 'aware'`,
Structural/rewrite, registered after the Project `inner-join-existence-recovery`
block and before `fanout-lookup-join` / `join-elimination` / the priority-26 IND
folders). It recovers the probe-only semi/anti shape the Project rule does, but for
the bare aggregate query that plans with **no enclosing Project**:

```
Aggregate(count(*))                  Aggregate(count(*))
  Filter(hasP)          ───────▶        SemiJoin(L, R, cond)   -- where hasP   (semi)
    Join[left, exists hasP]              AntiJoin(L, R, cond)   -- where not hasP (anti)
      L  R                                 L  R
```

### Shared-helper refactor (touched both Project callers)

`analyzeChain` no longer takes a `ProjectNode`; it takes a **pre-seeded
`demanded: Set<number>`** and folds the chain's non-probe conjuncts + sort keys into
it. The projection seed loop moved out into each caller:
- `ruleSemijoinExistenceRecovery` (Project) — seeds from `node.projections`.
- `ruleInnerJoinExistenceRecovery` (Project) — seeds from `node.projections` (now
  also imports `collectAttrIds`).
- `ruleSemijoinExistenceRecoveryUnderAggregate` (Aggregate, new) — seeds from
  `node.groupBy` + each `agg.expression`.

All three destructure only `{ probe }` and use the locally-seeded set (the returned
`demanded` is the same object), keeping the conjunct-walking / probe-classification
logic DRY across all three entrypoints.

### Divergences from the Project rule (the only two)

1. **Demand seed** — group-by exprs + aggregate exprs instead of projections.
2. **Rebuild epilogue** — `new AggregateNode(scope, newSource, groupBy, aggregates,
   undefined, node.getAttributes())` with `preserveAttributeIds`, guarded by an
   `isRelationalNode(newSource)` check (parity with the two shipped aggregate
   siblings).

**Deliberate scope limit:** the aggregate anchor has **no inner-join fallback** — a
right-column-demanded (`count(p.pv) … where hasP`) or fan-out *positive* probe stays
a flag-bearing `left` join (sound, just unoptimized). Documented in
`docs/optimizer.md` and the rule header; an aggregate-anchored inner rule is a
follow-up if a real workload ever wants it (not filed — speculative).

## Review findings

**Method.** Read the implement diff (`12cdeeaa`) with fresh eyes before the handoff
summary, then read the full current rule source, the shared `walkChain` whitelist,
the `AggregateNode` constructor, the proven `ruleJoinExistencePruningUnderAggregate`
rebuild for parity, both test specs, the pruning-spec lifecycle, the optimizer
registration block, and the `docs/optimizer.md` entries for both recovery rules.
Re-ran lint + targeted specs + the 08.2 logic file + the full suite independently
this session (the prior run hit the session limit immediately after a green full
suite; the git tree was clean at the implement SHA).

**Correctness / soundness — checked, no issues.**
- The new rule is a faithful mirror of the two proven `…UnderAggregate` siblings:
  identical sole-spec / `left` / `side === 'right'` / `condition`-present gates, the
  pre-seeded `analyzeChain`, the SEMI-only fan-out guard (`rightMatchesAtMostOne`),
  the anti fan-out immunity, the impure-R guard (`subtreeHasSideEffects`), and the
  `preserveAttributeIds` rebuild with the `isRelationalNode` belt-and-suspenders
  check.
- `walkChain` returns null on any non-whitelisted node (incl. an intervening
  `Project`), so the Project and Aggregate anchors never collide on the same subtree.
- **`count(*)` demand seed** (implementer-flagged): empirically sound — the
  `count(*) … where hasP` case recovers a semi with count = baseline 2; had
  `count(*)` carried a hidden right-side column ref, the `rightAttrIds` gate would
  have abstained (stayed `left`). The `count(p.pv)` case confirms a genuine right-col
  ref IS detected and correctly abstains.
- **Aggregate FILTER / HAVING edges** (verified by construction, not separately
  tested): `count(*) filter (where flag)` would land `flagId` in `demanded` via
  `agg.expression` → `demanded.has(flagId)` abstains (sound). HAVING is a `Filter`
  *above* the Aggregate referencing only aggregate outputs, invisible to `walkChain`
  — covered by the `having count(*) >= 0` test.
- **No-Project-shape assumption** (implementer-flagged): the `joinTypeOf === 'semi'`
  plan assertions would fail if a stray Project intervened (rule would silently never
  fire). Passing assertions confirm the bare-aggregate shape holds.

**Tests — checked, adequate; all pass.**
- `rule-semijoin-existence-recovery.spec.ts`: new `describe('aggregate anchor …')`
  with 10 cases covering semi, anti, HAVING, grouped-on flag, right-col-demanded,
  sibling-prune-then-recover, two-demanded-flags, fan-out positive (stays left) /
  anti (recovers), and residual AND-conjunct. A new `resultsNoAnyRecovery` baseline
  disables all three recovery rules so every result-equality assertion compares
  against a genuine flag-bearing nested-loop baseline (restored in `finally`,
  composes existing `disabledRules`). Plan assertions pin `joinExistence` /
  `joinTypeOf`; result assertions pin both the count and full row-equality vs.
  baseline. Both abstention branches are covered (the spec's `where hasP group by
  hasP` exercises the `demanded.has(flagId)` branch; the e2e file covers the pure
  `group by hasP` no-where path).
- `08.2-existence-flag-semijoin-recovery.sqllogic`: new end-to-end aggregate section
  over fresh seeded data (matched/unmatched counts, HAVING, group-by) plus a fan-out
  section asserting the non-collapsed `count(*) = 3` positive probe and `= 1` anti.
- `rule-join-existence-pruning.spec.ts`: one existing test (`retained when the flag
  is referenced only by a WHERE filter under the aggregate`) was modified to disable
  `semijoin-existence-recovery-aggregate`, because that exact `count(*) … where hasP`
  shape is now recovered to a semi join. **Sanity-checked this call (implementer
  asked):** isolating the pruning rule's demand analysis keeps the test focused on
  pruning; the alternative (re-pointing the assertion at the recovered semi shape)
  would conflate two rules. The isolation choice is correct. `DEFAULT_TUNING` is
  imported and `db` is recreated per-test (`beforeEach`), so the inline tuning
  override does not leak across tests.

**Docs — checked, current.** `docs/optimizer.md` documents the two-entrypoint split,
the pre-seeded `analyzeChain`, the no-inner-fallback limitation, the HAVING note, and
moves the aggregate anchor out of the deferred list (an aggregate-anchored *inner*
fallback remains explicitly deferred). The rule header and registration comment match
the shipped behavior.

**Maintainability observation (no action — intentional).** The two semijoin
entrypoints share ~40 lines of identical gate / guard / `JoinNode`-construction code,
differing only in the demand seed and rebuild epilogue. This duplication is
**deliberate and consistent** with the two established sibling pairs
(`ruleJoinExistencePruning`/`UnderAggregate`, `ruleJoinElimination`/`UnderAggregate`),
which use the same paired-function shape. Extracting a shared core here would diverge
from that convention and reduce per-rule top-to-bottom readability; left as-is.

**Major findings:** none — no new fix/plan/backlog tickets filed.

**Deferred / not done (carried from implement, reviewed and accepted):**
- Aggregate-anchored *inner* fallback — out of scope, speculative; not filed.
- `case`-wrapped probe forms — pre-existing deferral, shared with the Project rule.
- `yarn test:store` not run — pure logical optimizer rewrite, no store-specific
  surface; the memory-backed default exercises the full path. Same deferral the
  sibling tickets documented.

### Validation runs (all green, re-run this session)

- `yarn workspace @quereus/quereus lint` — exit 0.
- recovery + pruning + inner-recovery specs — **89 passing**.
- `08.2` sqllogic (`logic.spec.ts --grep 08.2`) — **1 passing**.
- full `yarn workspace @quereus/quereus test` — **5152 passing, 9 pending, 0 failing**.

## End
