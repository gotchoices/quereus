description: Recover an `inner join` from a `left join … exists right as <flag>` when the flag is a POSITIVE top-level probe (`where <flag>`) AND ≥1 right-side column is demanded above the join — the demand-SHAPE complement of `semijoin-existence-recovery`, which abstains exactly here.
prereq:
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (sibling — export its probe machinery for reuse), packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts (NEW rule), packages/quereus/src/planner/rules/join/rule-join-elimination.ts (shared walkChain/rebuildChain helpers — unchanged), packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/optimizer.ts (registration), packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts (NEW), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (one assertion flips), packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic (NEW), docs/optimizer.md
----

## Summary

`semijoin-existence-recovery` recovers a **semi/anti** join from a probe-only
`exists … as` flag, but abstains the moment a right-side column is demanded
(`select c.*, p.name … where hasP`) — a semi join would drop the very right
columns the caller needs. This rule is the complement: same probe machinery,
but for a **positive** probe (`where hasP`) **with right columns demanded**,
rewrite the `left join` to an **inner join** (drop the flag, keep both sides).

```sql
select c.cc, p.pv
from exc c left join exp p on p.pp = c.pr exists right as hasP
where hasP;          -- ⇒ inner join (matched rows only; p.pv needed → keep right cols)
```

This is a **pure optimization** — byte-identical rows to the flag-bearing
nested-loop baseline — that re-opens inner-join physical selection
(`join-physical-selection` → hash/merge join), non-nullable right-column typing,
and the FK/IND reasoning the live flag pinned shut (the five flag-guarded join
rules re-enable once `hasExistenceColumns` flips false).

## Why this is sound (and SIMPLER than the semi rule)

`emitLoopJoin` drives a `left join … exists right as` exactly like a normal left
join with one appended flag bit (`packages/quereus/src/runtime/emit/join.ts`
`driveFromLeft`):

- a matched left row with **K** matching right rows → **K** output rows, each
  `flag = true` (line 109, `matchedFlags`);
- an unmatched left row → **1** null-extended row, `flag = false` (line 113–114,
  `leftUnmatchedFlags`).

A positive probe `where hasP` keeps exactly the K matched rows per left row and
drops the unmatched. An **inner join** on the same condition yields exactly K
rows per matched left row and drops the unmatched. **Identical, row-for-row, for
ANY condition.** Consequences that distinguish this rule from the semi rule:

- **No fan-out guard.** The semi rule needs `rightMatchesAtMostOne` because a
  semi join collapses K→1; an inner join does not collapse, so K matches stay K.
  Do **not** import the uniqueness / `isUnique` machinery.
- **No condition-shape restriction.** Unlike `join-elimination` (AND-of-equalities
  + FK→PK), the inner conversion replays the flag's exact per-pair match, so
  non-equi / residual ON conditions are fine — carry `join.condition` verbatim.
- **No NOT-NULL FK requirement.** A `NULL` FK never satisfies `p.pp = c.pr`, so it
  is unmatched under both the flag (`false`, dropped by `where hasP`) and the
  inner join (no match). No NULL-FK row leaks.

### Attribute-id / nullability preservation

`buildJoinAttributes` (`join-utils.ts:47`) emits `[left…, right…]` for **both**
`left` and `inner`, taking right attribute ids **verbatim** from `rightAttrs`;
the only difference is that `left` marks the right columns `nullable: true` while
`inner` keeps their declared nullability. So:

- The consuming Project/Filter resolves right columns by attribute id (key-based
  addressing) and finds them at the same ids — no rebinding needed.
- Dropping the flag (appended *after* both sides) does not shift any right
  column's position.
- The inner join's non-nullable right typing is a sound **strengthening**: after
  `where hasP` only matched rows survive, on which the right side is fully
  present. This is the property that re-enables downstream FD/key reasoning.

### Soundness of dropping the flag + stripping the probe

Q2's demand-SHAPE proof (reused verbatim from the sibling) guarantees the flag is
referenced **only** in the single probe conjunct. After `left → inner` the probe
`where hasP` is subsumed by the inner join (which keeps only matched rows where
the flag would be `true`), so the probe conjunct is stripped via
`rebuildChainStrippingProbe` (Filter omitted if it was the sole conjunct). Any
flag reference outside the probe lands in `demanded`, and check (b) abstains.

## Relationship to `semijoin-existence-recovery` (disjoint by construction)

| Probe | Right col demanded? | Fires | Result |
|-------|--------------------|-------|--------|
| `where flag` (semi) | NO  | `semijoin-existence-recovery` | `semi(L,R,cond)` |
| `where not flag` (anti) | NO | `semijoin-existence-recovery` | `anti(L,R,cond)` |
| `where flag` (semi) | **YES** | **this rule** | `inner join` |
| `where not flag` (anti) | YES | *neither* | stays `left` + flag |

The two recovery rules partition the positive-probe space by the
right-column-demanded predicate, so they never both fire on one node. The
negative-probe + right-col case stays a `left` join: an anti row has the right
side all-NULL, so an inner join would be wrong. Registered **after** the semi
rule (so semi wins its half) and **before** `join-elimination` / the IND folders
(so the recovered inner join threads into them in the same `applyRules` loop).

The **positive-probe + NO-right-col + fan-out** case (where the semi rule
abstains on `rightMatchesAtMostOne` and an inner join would still be a sound,
physical-selection-re-enabling win) is intentionally **out of scope** here — it
is parked in `tickets/backlog/inner-join-recovery-fanout-fallback.md` because it
is a distinct value case (no right cols → inner join materializes unused right
columns; the win is physical selection, not the kept columns) with its own
gating story. Keeping this ticket the clean complement of the sibling.

## Rule shape (`rule-inner-join-existence-recovery.ts`, id `inner-join-existence-recovery`)

Anchor `ProjectNode`; reuse the sibling's exported machinery:

```
walk = walkChain(node.source, new Set())            // from rule-join-elimination
guard: walk != null
guard: join.joinType === 'left'
guard: join.hasExistenceColumns && existence.length === 1
guard: spec.side === 'right'
guard: join.condition present
analysis = analyzeChain(node, chain, flagId)         // EXPORTED from sibling
guard: analysis != null
guard: analysis.probe.polarity === 'semi'            // POSITIVE probe only
guard: !analysis.demanded.has(flagId)                // flag not otherwise demanded
rightAttrIds = join.right.getAttributes().map(a => a.id)
guard: rightAttrIds.some(id => analysis.demanded.has(id))   // ≥1 right col demanded (the complement gate)
guard: !PlanNodeCharacteristics.subtreeHasSideEffects(join.right)   // impure-R guard (see below)
innerJoin = new JoinNode(join.scope, join.left, join.right, 'inner', join.condition)
newSource = rebuildChainStrippingProbe(chain, analysis.probe, innerJoin)   // EXPORTED from sibling
return rebuildProject(node, newSource)
```

### Shared-helper extraction (DRY)

`analyzeChain`, `classifyProbe`, the `ProbeMatch` interface, and
`rebuildChainStrippingProbe` already compute exactly what this rule needs.
Add `export` to them in `rule-semijoin-existence-recovery.ts` and import them
into the new rule. This mirrors the existing pattern where the semi rule itself
imports `walkChain` / `collectAttrIds` / `rebuildChain` / `rebuildProject` /
`ChainEntry` from `rule-join-elimination.ts` — sibling-rule helper sharing is the
established idiom in `planner/rules/join/`. Do **not** duplicate the functions.
(`analyzeChain` classifies polarity for both `semi`/`anti`; this rule simply
keeps only `semi`. No change to its logic is required.)

### `sideEffectMode: 'aware'` + impure-R guard

Register **`'aware'`** and keep the `subtreeHasSideEffects(join.right)` refusal.
Rationale: although the *logical* inner join scans R the same number of times as
the flag-bearing left join (both full-scan R per left row in `driveFromLeft`,
neither short-circuits), dropping the flag **re-enables `join-physical-selection`**,
which can pick a hash join that scans R **once** total — changing an impure R's
execution count. Guarding at the recovery site (rather than trusting every
re-enabled downstream rule) mirrors the sibling's Q7 guard and
`subquery-decorrelation`'s impure-inner refusal. Write-half safety is otherwise
by construction: a flag writable through a view is always SELECTed by its routing
Project, so it lands in `demanded` and the `!demanded.has(flagId)` check abstains.

### Registration (optimizer.ts)

Add immediately **after** the `semijoin-existence-recovery` block (priority 23,
registration order), keeping it before `fanout-lookup-join` / `join-elimination`
(24) and the Join-typed IND folders (26). Pass rules fire in REGISTRATION order,
so placement after the semi block is what makes semi win the no-right-col half.

```
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'inner-join-existence-recovery',
  nodeType: PlanNodeType.Project,
  phase: 'rewrite',
  fn: ruleInnerJoinExistenceRecovery,
  priority: 23,
  sideEffectMode: 'aware',
});
```

## Edge cases & interactions

- **Negative probe (`where not hasP`) with right cols demanded** → must NOT fire
  (anti rows have all-NULL right side). Guarded by `polarity === 'semi'`. Stays a
  `left` join with the flag retained. Add a no-fire test.
- **No right column demanded** (`select c.cc … where hasP`) → must NOT fire here
  (defer to `semijoin-existence-recovery`'s semi). The `rightAttrIds.some(…)`
  gate enforces this. Verify the semi rule still wins (test: `joinType === 'semi'`).
- **Flag also selected / sorted on** (`select cc, hasP …`, `… order by hasP`) →
  `demanded.has(flagId)` true → abstain; flag retained. (Mirror the sibling's
  no-fire tests.)
- **OR / non-probe shape** (`where hasP or cv > 150`) → `classifyProbe` returns
  null inside `analyzeChain` → abstain; flag retained.
- **`hasP is [not] null`** over the never-null flag → constant, not a probe →
  `analyzeChain` abstains; flag retained. (Reuses the sibling's matcher exactly.)
- **Two demanded flags** (`exists right as hasA, exists right as hasB`, one
  probed, one selected) → `existence.length !== 1` → abstain. When a sibling flag
  is merely *undemanded*, `join-existence-pruning` (priority 22) drops it first,
  leaving a sole flag this rule recovers in a later `applyRules` iteration —
  assert the cascade.
- **Residual AND-conjunct** (`where hasP and c.cv > 150`) → probe stripped, the
  `c.cv > 150` conjunct retained above the inner join via
  `rebuildChainStrippingProbe`. Inner join makes right cols non-null, so a residual
  on a right column evaluates on real values (same as baseline).
- **`select *` / `select c.*, p.col`** — `select *` expands to demand both sides;
  with a right col present this rule fires and produces the inner join. Confirm
  `select *` rows match the baseline (the flag column itself must NOT appear in
  `select *` output — verify `exists … as` flags are excluded from `*` expansion;
  if a `*` includes the flag it lands in `demanded` and the rule abstains, which
  is also correct).
- **NULL FK** (`pr = null`, no match) → unmatched under both plans; dropped by
  `where hasP` and absent from the inner join. Seed data must include a NULL-FK
  row and assert it is absent (e.g. `seedExisting` cc=4).
- **Fan-out with right cols demanded** (one left row matches K>1 right rows, right
  col selected) → inner join correctly yields K rows; this is the case the semi
  rule could NOT handle. Add a positive test asserting the K-row output equals the
  baseline (this is a headline capability — the semi rule abstains, this rule
  fires and is correct).
- **Impure R** (a write on the right subtree) → `subtreeHasSideEffects` refusal;
  flag retained.
- **USING joins / RIGHT/FULL origin / inner origin** — out of scope: the
  `join.condition` guard excludes USING (condition is undefined for USING joins),
  `joinType === 'left'` excludes RIGHT/FULL, and the parser rejects `exists … as`
  on inner/cross. All sound abstentions (forgo the rewrite only).
- **Termination**: output is an inner join with no existence spec; re-running the
  rule sees `joinType !== 'left'` and no-ops. No rewrite loop.
- **Downstream `join-elimination` does NOT fire** while a right column is demanded
  (it requires the non-preserved side unreferenced). The win in-scope is physical
  selection + non-nullable typing + FD/IND reasoning, NOT elimination. Do not
  claim elimination as an in-scope benefit (the doc text's "elimination" applies
  to the parked no-right-col fallback).

## Test updates required (existing)

`packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts:386`
currently asserts the `select cc, p.pv … where hasP` case **keeps the flag**
("deferred outer→inner case"). Once this rule lands, that flag is dropped and the
join becomes `inner`. **Flip that test**: move it (or add a sibling assertion) so
it expects `joinExistence === undefined` and `joinTypeOf === 'inner'`, with rows
still equal to `resultsNoRecovery`. Update its comment — the case is no longer
deferred.

## Docs

`docs/optimizer.md`:
- Add a `ruleInnerJoinExistenceRecovery` (id `inner-join-existence-recovery`)
  bullet in the **Join** section after the `ruleSemijoinExistenceRecovery`
  bullet, describing: positive-probe + right-col-demanded ⇒ inner join, no
  fan-out / no condition-shape / no NOT-NULL restrictions, attribute-id +
  non-nullable-strengthening preservation, the impure-R guard, and registration.
- Edit the `ruleSemijoinExistenceRecovery` bullet (line ~495): remove "the
  outer→inner conversion" from its **Deferred** list and point at the new rule;
  the (c) "no right-side column demanded" abstention now explicitly hands off to
  `inner-join-existence-recovery` rather than being a dead end.

## Key tests to write (TDD targets)

New optimizer spec `rule-inner-join-existence-recovery.spec.ts` (mirror the
sibling's `planRows` / `joinTypeOf` / `joinExistence` / `resultsNoRecovery`
helpers; every case asserts rows == `resultsNoRecovery` baseline):

- **headline**: `select c.cc, p.pv … where hasP` ⇒ flag gone, `joinTypeOf ===
  'inner'`, rows `[{cc:1,pv:10},{cc:3,pv:20}]` (seedExisting), equals baseline.
- **physical selection re-enabled**: same query, assert a physical join op
  appears (`hasPhysicalJoin`) — the flag no longer pins nested-loop.
- **probe normal forms** carry over: `hasP = true`, `hasP is true`, `hasP is not
  false`, `not not hasP` (all positive) ⇒ inner; assert each.
- **fan-out + right col** (the semi rule cannot do this): `setupFanOut`-style with
  a right column selected, left row matches 3 right rows ⇒ 3 inner-join rows ==
  baseline (no collapse).
- **residual conjunct**: `where hasP and c.cv > 150` ⇒ inner join + retained
  `cv > 150` filter; rows match baseline.
- **no-fire** (flag retained, `joinTypeOf` stays `left` or defers to semi):
  - `where not hasP` + right col ⇒ stays `left`.
  - no right col (`select c.cc … where hasP`) ⇒ `semijoin-existence-recovery`
    wins ⇒ `joinTypeOf === 'semi'` (NOT inner).
  - `select cc, hasP, p.pv … where hasP` (flag selected) ⇒ flag retained.
  - `where hasP or c.cv > 150` ⇒ flag retained.
  - `where hasP is not null` ⇒ flag retained (constant, not a probe).
  - two demanded flags ⇒ flag(s) retained.
- **cascade**: undemanded sibling flag pruned first, sole survivor + right col ⇒
  inner.
- **disabled**: with `disabledRules: {'inner-join-existence-recovery'}`, the
  flag-bearing nested-loop left join survives.

New `test/logic/08.3-existence-flag-inner-recovery.sqllogic` mirroring
`08.2-existence-flag-semijoin-recovery.sqllogic`: end-to-end result correctness
for the inner-recovery shapes (probe forms, fan-out + right col, residual
conjunct, NULL FK), each `→` asserting exact rows.

## TODO

- Export `ProbeMatch`, `analyzeChain`, `classifyProbe`, `rebuildChainStrippingProbe`
  from `rule-semijoin-existence-recovery.ts` (add `export`; no logic change).
- Create `rule-inner-join-existence-recovery.ts` with
  `ruleInnerJoinExistenceRecovery` per the rule shape above; thorough file-header
  doc comment in the sibling's style (cross-reference the sibling, state the
  no-fan-out / no-condition-shape / non-nullable-strengthening soundness args).
- Register the rule in `optimizer.ts` after the `semijoin-existence-recovery`
  block (`'aware'`, priority 23, registration order before `fanout-lookup-join`).
- Flip `rule-semijoin-existence-recovery.spec.ts:386` (deferred case → inner).
- Add `rule-inner-join-existence-recovery.spec.ts` and
  `test/logic/08.3-existence-flag-inner-recovery.sqllogic`.
- Update `docs/optimizer.md` (new bullet + de-defer the sibling bullet).
- `yarn workspace @quereus/quereus run build`, then lint, the new optimizer spec,
  and `yarn test` (stream with `tee`); verify no regression in the semi spec.
