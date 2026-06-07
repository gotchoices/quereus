<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-07T09:56:36.345Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\semijoin-existence-recovery-aggregate-anchored.review.2026-06-07T09-56-36-345Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Aggregate-anchored variant of `semijoin-existence-recovery`. Adds `ruleSemijoinExistenceRecoveryUnderAggregate` — a second entrypoint anchored on `AggregateNode` that recovers a semi/anti join from a probe-only `left join … exists right as <flag>` sitting under a bare `count(*)` / `group by` with no enclosing Project (e.g. `select count(*) from child c left join parent p on … exists right as hasP where hasP`). Shares ALL probe-detection + chain-rewrite machinery with the Project entrypoint; only the demand seed (group-by + aggregate exprs) and rebuild epilogue (`AggregateNode` with `preserveAttributeIds`) differ. Mirrors how `ruleJoinExistencePruningUnderAggregate` / `ruleJoinEliminationUnderAggregate` extended their Project siblings.
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, docs/optimizer.md
----

## What shipped

A second entrypoint, `ruleSemijoinExistenceRecoveryUnderAggregate`
(`rule-semijoin-existence-recovery.ts`), registered as `semijoin-existence-recovery-aggregate`
(`optimizer.ts`, `nodeType: Aggregate`, `priority: 23`, `sideEffectMode: 'aware'`,
registered immediately after the Project `inner-join-existence-recovery` block and
before `fanout-lookup-join` / `join-elimination` / the priority-26 IND folders). It
recovers the same probe-only semi/anti shape the Project rule does, but for the bare
aggregate query that plans with **no enclosing Project**:

```
Aggregate(count(*))                  Aggregate(count(*))
  Filter(hasP)          ───────▶        SemiJoin(L, R, cond)   -- where hasP   (semi)
    Join[left, exists hasP]              AntiJoin(L, R, cond)   -- where not hasP (anti)
      L  R                                 L  R
```

### Shared-helper refactor (touches both Project callers)

`analyzeChain` no longer takes a `ProjectNode` — it now takes a **pre-seeded
`demanded: Set<number>`** and folds the chain's non-probe conjuncts + sort keys into
it. The projection seed loop moved out into each caller:

- `ruleSemijoinExistenceRecovery` (Project) — seeds from `node.projections`.
- `ruleInnerJoinExistenceRecovery` (Project) — seeds from `node.projections`
  (now also imports `collectAttrIds`). **Both Project call sites were updated.**
- `ruleSemijoinExistenceRecoveryUnderAggregate` (Aggregate, new) — seeds from
  `node.groupBy` + each `agg.expression`.

The return shape stayed `{ demanded, probe } | null`; all three callers now
destructure only `{ probe }` and use their locally-seeded set (the returned
`demanded` is the same object). This keeps the substantial conjunct-walking /
probe-classification logic DRY across all three entrypoints.

### The new rule body (mirror of the Project rule)

Same gates verbatim (`joinType === 'left'`, `hasExistenceColumns`,
`existence.length === 1`, `spec.side === 'right'`, `condition` present), same
fan-out guard (`rightMatchesAtMostOne`, **semi only**), same impure-R guard
(`subtreeHasSideEffects(join.right)`), same probe-strip rebuild
(`rebuildChainStrippingProbe`). The **only** two divergences from the Project rule:

1. **Demand seed** — group-by exprs + aggregate exprs instead of projections.
2. **Rebuild epilogue** — `new AggregateNode(scope, newSource, groupBy, aggregates,
   undefined, node.getAttributes())` with `preserveAttributeIds`, guarded by an
   `isRelationalNode(newSource)` belt-and-suspenders check (parity with the two
   shipped aggregate siblings).

**Deliberate scope limit:** the aggregate anchor has **no inner-join fallback.** A
right-column-demanded probe (`count(p.pv) … where hasP`) or a fan-out *positive*
probe stays a flag-bearing `left` join — sound, just unoptimized. (The Project anchor
hands those to `rule-inner-join-existence-recovery`; there is no aggregate-anchored
inner rule in scope. Documented in `docs/optimizer.md` and the rule header.)

## Behaviour table (what fires vs. abstains, under an aggregate)

| Query shape (under `Aggregate`, no Project)                | Result        | Why |
|------------------------------------------------------------|---------------|-----|
| `count(*) … where hasP` (unique R)                         | **semi**      | sole probe, ≤1 match |
| `count(*) … where not hasP`                                | **anti**      | anti immune to fan-out |
| `count(*) … where hasP having count(*) >= 0`               | **semi**      | HAVING is a Filter *above* the Aggregate; invisible to walkChain |
| `count(*) … where hasP and c.cv > 150`                     | **semi** + residual Filter | residual conjunct retained below the Aggregate |
| `select hasP, count(*) … where hasP group by hasP`         | stays `left`  | flag grouped-on ⇒ `demanded.has(flagId)` |
| `count(p.pv) … where hasP`                                 | stays `left`  | right col demanded; no aggregate inner fallback |
| `count(*) … where h` over fan-out R                        | stays `left`  | semi fan-out guard abstains; no inner fallback |
| `count(*) … where not h` over fan-out R                    | **anti**      | unmatched rows never duplicate |
| `… exists hasA, exists hasB where hasB` (hasA unused)      | **semi**      | pruning (pri 22) drops hasA → sole hasB recovered (pri 23) |
| `select hasA, count(*) … exists hasA, hasB where hasB group by hasA` | stays `left` | two demanded flags ⇒ `existence.length !== 1` |

## Tests / validation (the floor, not the ceiling)

- **`test/optimizer/rule-semijoin-existence-recovery.spec.ts`** — new nested
  `describe('aggregate anchor …')` with 10 cases covering every row of the table
  above, plus a new `resultsNoAnyRecovery` baseline that disables **all three**
  recovery rules (both Project + the new aggregate one) so each result-equality
  assertion compares against a genuine flag-bearing nested-loop baseline (not a
  near-tautology). Plan assertions pin `joinExistence`/`joinTypeOf`; result
  assertions pin the count values AND row-equality vs. baseline.
- **`test/logic/08.2-existence-flag-semijoin-recovery.sqllogic`** — new end-to-end
  aggregate section over fresh seeded data: `count(*) … where hasP` (matched count),
  `where not hasP` (unmatched), `having count(*) >= 0`, `group by hasP`, plus a
  fan-out section asserting the fanned-out (non-collapsed) `count(*) = 3` for the
  positive probe and `= 1` for the anti.
- **`test/optimizer/rule-join-existence-pruning.spec.ts`** — one existing test
  (`retained when the flag is referenced only by a WHERE filter under the aggregate`)
  was modified: that exact `count(*) … where hasP` shape is now recovered to a semi
  join, so the test (which means to isolate the *pruning* rule's demand analysis)
  now disables `semijoin-existence-recovery-aggregate` to keep its "flag retained"
  assertion meaningful. **Reviewer: sanity-check this call** — the alternative would
  be to re-point the assertion at the recovered semi shape; I chose isolation to keep
  the pruning test focused on pruning.
- **`docs/optimizer.md`** — extended the `semijoin-existence-recovery` entry with the
  two-entrypoint split and the no-inner-fallback note; removed "the aggregate anchor"
  from the deferred list (now shipped).

### Validation runs (all green)

- `yarn workspace @quereus/quereus build` — exit 0.
- `yarn workspace @quereus/quereus lint` — exit 0.
- recovery spec — **38 passing** (incl. 10 new aggregate cases).
- 08.2 sqllogic — green; inner-recovery + pruning + elimination specs — **73 passing**.
- all optimizer specs — **1293 passing**; all sqllogic files — **228 passing**;
  query-rewrite + property-planner (random queries through the full optimizer) —
  **83 passing**.
- full `yarn workspace @quereus/quereus test` — **5152 passing, 9 pending, 0 failing**
  (~2 min).

## Honest gaps / things for the reviewer to scrutinize

- **`count(*)` demand seed.** The rule assumes `collectAttrIds(count(*).expression)`
  contributes no column refs (so the count-only demand set is empty and the probe is
  the sole flag reference). Verified empirically (semi recovers, count correct), but a
  reviewer may want to eyeball how `count(*)` is represented to confirm there's no
  hidden column reference that would change `demanded`.
- **No-Project-shape assumption.** The whole rule rests on `select count(*) from …`
  planning as `Aggregate` with no enclosing `Project`. Two shipped siblings depend on
  the same shape, and the `joinTypeOf === 'semi'` plan assertions would catch a stray
  Project (the rule would silently never fire). Confirmed empirically by the passing
  plan assertions, but it is an assumption worth a fresh look.
- **`group by hasP` (no WHERE) abstains via "no probe", not `demanded.has(flagId)`.**
  Both paths retain the flag. The spec's group-by test uses `where hasP group by hasP`
  specifically to exercise the `demanded.has(flagId)` branch; the e2e file covers the
  pure `group by hasP` (no where) path. Reviewer may want to confirm both branches are
  intentionally covered.
- **Sibling-prune-then-recover ordering** relies on the pass framework cascading
  `join-existence-pruning-aggregate` (22) → this rule (23) in registration order
  within one `applyRules` fixpoint. Tested and green, but it is the one
  cross-rule-ordering dependency.
- **No aggregate inner fallback** is a deliberate scope cut (right-col-demanded /
  fan-out positive probes stay `left`). Sound, but if a real workload wants those
  optimized, that's a follow-up (an aggregate-anchored inner rule) — not filed.
- **Write-half / termination** are safe by construction (flag SELECTed in a routing
  Project ⇒ demanded ⇒ abstain; output semi/anti has no flag ⇒ re-run no-ops) and not
  separately unit-tested for the aggregate path — same by-construction argument the
  Project rule and the two aggregate siblings rely on.
- **`yarn test:store` not run** — pure logical optimizer rewrite, memory-backed
  default exercises the full path; no store-specific surface. Same deferral the
  sibling tickets documented. Reviewer may run it if desired.
