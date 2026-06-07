description: Recover a semi / anti-join access path from a `left join … exists right as <flag>` whose flag is demanded ONLY as a pure top-level boolean probe (`where <flag>` ⇒ semi, `where not <flag>` ⇒ anti). The flag pins the join to a nested-loop today (the five flag-guarded rules abstain while `hasExistenceColumns` is true). A new Structural rule anchored on `ProjectNode` proves the flag is used solely as a probe (demand-SHAPE analysis), then rewrites the `JoinNode` to the equivalent `semi`/`anti` join — the same node shape `ruleSubqueryDecorrelation` emits — re-opening physical join selection and the IND-folding cascade (`semi-join-fk-trivial` / `anti-join-fk-empty`). Pure optimization; rows must be byte-identical to the nested-loop+flag baseline.
prereq:
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (NEW), packages/quereus/src/planner/rules/join/rule-join-elimination.ts (reuse collectAttrIds / rebuildProject / isAndOfColumnEqualities; ChainEntry kinds), packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (demand-shape precedent, not modified), packages/quereus/src/planner/optimizer.ts (register the rule), packages/quereus/src/planner/nodes/join-node.ts (JoinNode ctor, ExistenceColumnSpec, extractEquiPairsFromCondition), packages/quereus/src/planner/nodes/filter.ts (FilterNode), packages/quereus/src/planner/analysis/predicate-conjuncts.ts (splitConjuncts / combineConjuncts), packages/quereus/src/planner/analysis/predicate-normalizer.ts (normalizePredicate), packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode / BinaryOpNode / LiteralNode), packages/quereus/src/planner/nodes/reference.ts (ColumnReferenceNode), packages/quereus/src/planner/framework/characteristics.ts (subtreeHasSideEffects), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (NEW), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (test-harness pattern to copy: planRows / joinCount / hasPhysicalJoin / results / resultsNoPrune), docs/optimizer.md, docs/view-updateability.md
----

## Summary of the resolved design

The base rule `join-existence-pruning` drops an `exists … as` flag only when
**nothing** demands its attr id (dead-column prune). This rule handles the
complementary shape: the flag **is** demanded, but **only** as a pure boolean
existence probe at the top level. That is exactly a semi / anti-join, and
rewriting it as one re-enables the access-path choice the live flag forfeits.

```sql
-- semijoin shape: keep child rows that HAVE a matching parent
select c.* from child c left join parent p on p.pk = c.fk exists right as hasP
  where hasP;            -- ⇒ SemiJoin(child, parent, p.pk = c.fk)

-- anti-semijoin shape: keep child rows that have NO matching parent
select c.* from child c left join parent p on p.pk = c.fk exists right as hasP
  where not hasP;        -- ⇒ AntiJoin(child, parent, p.pk = c.fk)
```

This is a **pure optimization** — the nested-loop+flag plan is already correct,
just slower than the semi/anti shape. No correctness gap; the deliverable is
result-equality plus a re-enabled physical/IND cascade.

### Q1 — Anchor: `ProjectNode`, NOT `FilterNode` (settled)

The ticket leaned toward a Filter anchor (mirroring `ruleSubqueryDecorrelation`).
**Rejected as unsound.** Decorrelation is output-preserving at the Filter level
(`Filter[EXISTS](outer)` and `SemiJoin(outer,inner)` both expose *outer*'s
columns), so it never has to look above the Filter. Our case is different: the
probe Filter sits above a `left join` whose output is `[left…, right…, flag]`,
and the Filter passes all of those through. Rewriting the join to semi changes
the Filter's output to `[left…]` — dropping the right columns and the flag — so
soundness REQUIRES proving that nothing above the Filter references a right-side
column or the flag (except the probe we strip). A rule sees only its own
subtree, so the Filter anchor cannot prove that.

`ProjectNode` is the correct anchor for the same reason `join-existence-pruning`
uses it: a Project's output is exactly one attribute per projection
(`ProjectNode.getAttributes()` maps over `this.projections` in BOTH the
`preserveInputColumns` true and false branches — verified in
`project-node.ts:119-174`), so collecting demand from the projections bounds
**everything** any ancestor can reference. The probe Filter is reached via the
same whitelisted pass-through chain (`walkChain` in `rule-join-elimination.ts`)
and rewritten in place during chain reconstruction.

Aggregate-anchored shapes (`select count(*) … where hasP`, no enclosing Project)
are deferred to a backlog follow-up (see Deferred work) to keep this ticket to a
single agent run; the chain-walk should be written anchor-agnostic so that
follow-up is a small prologue/epilogue mirror.

### Q2 — Demand-shape proof ("used ONLY as a boolean probe")

Let `J` be the flag-bearing `JoinNode` reached by the chain walk, with sole
existence spec `f` (`flagId = f.attrId`). The rewrite is legal iff:

1. **Sole probe conjunct.** Across all `FilterNode`s in the chain, split each
   predicate with `splitConjuncts`. Exactly **one** conjunct references `flagId`,
   and it is in an accepted **probe normal form** (below). Any other reference to
   `flagId` anywhere — another conjunct, a Sort key, a projection — disqualifies.
2. **Flag absent from the residual demand set.** Build `demanded` from: the
   anchor Project's projections (`collectAttrIds` over `proj.node`), plus every
   chain `FilterNode`'s **non-probe** conjuncts, plus every chain `SortNode`'s
   keys. (`LimitOffset`/`Distinct`/`Alias` contribute nothing.) Require
   `!demanded.has(flagId)`.
3. **No right-side column demanded.** The semi/anti output is left columns only,
   so `demanded ∩ {J.right attr ids} === ∅`. (Without this, `select *` /
   `select c.*, p.col … where hasP` would silently lose right columns; those are
   the deferred outer→inner-conversion case, NOT this rewrite — see Deferred.)

**Accepted probe normal forms** (normalize each conjunct with
`normalizePredicate` first — this collapses `not not f` and pushes NOT down):

| Form | Node shape after normalize | Polarity |
|------|----------------------------|----------|
| `f` | `ColumnReferenceNode`, `attributeId === flagId` | semi (true) |
| `not f` | `UnaryOpNode` op `NOT`, operand is that `ColumnReferenceNode` | anti (false) |
| `f = true` / `true = f` | `BinaryOpNode` op `=`, one side the flag colref, other a boolean `LiteralNode` `true` | semi |
| `f = false` / `false = f` | same with literal `false` | anti |

`IS [NOT] TRUE/FALSE` forms are **deferred** to the probe-form-extensions
backlog ticket — check the AST/plan representation first; include only if it
reduces to one of the shapes above trivially, otherwise leave it to the backlog.

**Rejection criteria (must NOT fire):** flag in >1 conjunct; flag inside a
non-probe conjunct (`hasP or x`, `f(hasP)`, `hasP and y` nested under an `OR`);
flag selected or sorted on (lands in `demanded`); any right-side attr in
`demanded`; `J` not a `left` join; `J` with ≠ 1 existence spec; spec `side !==
'right'`; no `condition` on `J`.

### Q3 — left/right/inner → semi/anti mapping (settled by reachability)

The parser (`parser.ts` `resolveExistenceSide`) rejects `exists … as` on
**inner/cross** joins (no null-extended side), and the runtime
(`emitLoopJoin`, `join.ts:57`) throws `RIGHT/FULL JOIN is not supported yet`.
Therefore the **only executable flag-bearing shape is `left join … exists right
as`** (confirmed by the `existence-flag-pruning-aggregate-anchored` review). The
complete reachable mapping table:

| Join type | spec.side | probe polarity | rewrite | rows kept |
|-----------|-----------|----------------|---------|-----------|
| `left` | `right` | `where f` (true) | `semi(L, R, cond)` | L rows with a match in R |
| `left` | `right` | `where not f` (false) | `anti(L, R, cond)` | L rows with NO match in R |

`right` / `full` origins and `inner`-join flags are unreachable today and are
explicitly **out of scope** (guarded by `joinType === 'left' && spec.side ===
'right'`). A backlog note covers extending the table if RIGHT/FULL ever gain
runtime support. The semi/anti node takes the **left** side's attributes only
(`buildJoinAttributes` returns `leftAttrs.slice()` for semi/anti) — the flag
column disappears, which the Q2 checks (no flag/right demand) guarantee the
consuming Project tolerates.

### Q4 — Multi-flag joins: only fire when the probe is the SOLE existence spec

A semi/anti join collapses the right side and cannot also emit other flags, so a
mixed join (one probe flag + other genuinely-selected flags) cannot be split.
**Decision: require `J.existence.length === 1`.** When other flags are merely
*undemanded*, the base `join-existence-pruning` rule (priority 22, runs before
this rule) drops them first, leaving a sole flag this rule then recovers in a
later `applyRules` iteration. The genuinely-mixed case (≥2 demanded flags) is
left unoptimized — documented, no backlog ticket warranted.

### Q5 — Residual ON-condition + non-equi predicates (sound; carry verbatim)

`left join … where f` keeps exactly the L rows for which ∃ an R row satisfying
the FULL join condition — that is precisely `semi(L, R, condition)` for an
arbitrary `condition` (equi + residual + non-equi). So the constructed semi/anti
join carries `J.condition` **unchanged**. The downstream IND folders
(`semi-join-fk-trivial`, `anti-join-fk-empty`) gate on
`isAndOfColumnEqualities(normalizePredicate(condition))` and **abstain** on any
residual — leaving a plain `semi`/`anti` join, which still wins (hash semi-join
vs nested-loop+flag). No special handling needed; just do not over-restrict the
condition in this rule (it does NOT require AND-of-equalities itself).

### Q6 — Outer-side preservation / NULL semantics (clean partition)

The flag is `{true,false}` and **never NULL**: `EXISTENCE_FLAG_TYPE.nullable ===
false` (`join-utils.ts:40`) and `emitLoopJoin` pre-computes `matchedFlags`
(all `true`) and `unmatchedFlags` (`spec.side === 'left'` → `false` for an
`exists right as` spec). So for `left … exists right as`, flag is `true` exactly
on matched rows and `false` exactly on null-extended rows. Three-valued logic
never produces NULL here, so `where f` and `where not f` partition the L rows
into exact complements — the textbook semi / anti split. No NULL edge.

### Q7 — Write-half safety (excluded by construction)

A flag writable through a view is always SELECTed by that view's routing Project
(`join-existence-pruning` docstring, "Write-half safety is by construction"). A
flag that is *only* probed in `where` and never selected is, by Q2's "flag
absent from `demanded`" check, never the target of an UPDATE/INSERT-through-view
routing Project. So the write path cannot reach this rewrite. Mirror the base
rule's "write-half safety by construction" paragraph in the docstring. No
statement-level context needed.

Additionally, the rewrite changes the right side's *execution count* (a `semi`
join short-circuits the R scan at the first match), so guard impure R:
`if (PlanNodeCharacteristics.subtreeHasSideEffects(J.right)) return null;`, and
register the rule with `sideEffectMode: 'aware'` (mirroring
`subquery-decorrelation`, which likewise refuses an impure inner). The flag-drop
itself is read-only; the guard is purely about R's iteration count.

## Algorithm (Project anchor)

```
ruleSemijoinExistenceRecovery(node):
  if not ProjectNode: return null
  demanded = ∅; collectAttrIds(each projection.node) → demanded
  walk = chainWalk(node.source, demanded)            // own walk; see below
  if not walk: return null
  { join, chain } = walk
  if join.joinType !== 'left': return null
  if not join.hasExistenceColumns or join.existence.length !== 1: return null
  spec = join.existence[0]
  if spec.side !== 'right': return null
  if not join.condition: return null
  flagId = spec.attrId

  // locate the sole probe conjunct across chain Filters; classify polarity;
  // every NON-probe conjunct's attrs are already in `demanded` from the walk.
  probe = findSoleProbe(chain, flagId)               // {filter, conjunct, polarity} | null
  if not probe: return null
  if demanded.has(flagId): return null               // flag referenced off-probe
  if any(join.right attr id in demanded): return null // semi/anti drops right cols
  if subtreeHasSideEffects(join.right): return null

  newJoinType = probe.polarity === 'semi' ? 'semi' : 'anti'
  semiAnti = new JoinNode(join.scope, join.left, join.right, newJoinType,
                          join.condition /* no usingColumns, no existence */)
  newSource = rebuildChainStrippingProbe(chain, probe, semiAnti)
  return rebuildProject(node, newSource)
```

- **`chainWalk`**: model on `walkChain` (`rule-join-elimination.ts:130`) — same
  whitelist (Filter/Sort/LimitOffset/Distinct/Alias) down to the first JoinNode.
  Difference: for Filter, do NOT blindly add the whole predicate to `demanded`;
  add each conjunct's attrs, but remember per-Filter conjuncts so `findSoleProbe`
  can later identify and EXCLUDE the probe conjunct from demand. Simplest
  correct approach: have `chainWalk` record the chain entries (Filter nodes
  included) and add Filter/Sort attrs to `demanded` as today; then in
  `findSoleProbe`, if a probe is found, SUBTRACT its attrs — but subtraction is
  unsafe if the flag also appears elsewhere. Cleaner: split each Filter's
  conjuncts during the walk, add only **non-probe-candidate** conjuncts'
  attrs to `demanded`, and stash probe-candidate conjuncts (a conjunct that
  references `flagId` — but `flagId` is unknown until the join is found). Resolve
  the ordering by a **two-pass** structure: (1) walk to find the Join and chain
  (collecting attrs from everything), (2) re-scan the chain Filters for the sole
  `flagId` probe, and recompute `demanded` excluding that one conjunct. Pick
  whichever is clearest; the invariant that matters: `demanded` must contain the
  attrs of **every** consumer EXCEPT the single stripped probe conjunct.
- **`rebuildChainStrippingProbe`**: like `rebuildChain` (`:253`) but for the
  probe's `FilterNode`, rebuild with `combineConjuncts(non-probe conjuncts)` as
  predicate; if that is empty, **omit the Filter** (its rebuilt source becomes
  the level above's child). All other entries rebuild verbatim. The Join is
  replaced by `semiAnti`.
- Reuse `collectAttrIds`, `rebuildProject`, `ChainEntry` from
  `rule-join-elimination.ts`; `splitConjuncts`/`combineConjuncts` from
  `analysis/predicate-conjuncts.ts`; `normalizePredicate` from the normalizer.

## Registration (`optimizer.ts`)

```
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'semijoin-existence-recovery',
  nodeType: PlanNodeType.Project,
  phase: 'rewrite',
  fn: ruleSemijoinExistenceRecovery,
  priority: 23,               // 22 < p < 26 (see below)
  sideEffectMode: 'aware',    // changes R execution count (semi short-circuit)
});
```

Ordering constraints (the exact value within the window is not load-bearing
beyond these bounds — verify golden plans):
- **After** `join-existence-pruning` (Project, 22) so undemanded sibling flags
  are gone first, maximizing the sole-spec precondition.
- **Before** the IND folders `anti-join-fk-empty` / `semi-join-fk-trivial`
  (Join, 26) so the recovered semi/anti threads into them in the same
  `applyRules` loop (exactly why `subquery-decorrelation` (25) precedes 26).
- `join-elimination` (Project, 24) early-returns on flag-bearing joins, so
  ordering vs it is not load-bearing; placing this at 23 (before 24) is fine.

## Edge cases & interactions

- **`where hasP` (sole conjunct)** → `semi`; probe Filter dropped (empty
  residual). Result == baseline.
- **`where not hasP` (sole conjunct)** → `anti`; probe Filter dropped.
- **`where hasP and x > 5`** (x a left column) → `semi`; residual `x > 5` Filter
  retained ABOVE the semi join (split the Filter, do not fold the residual into
  the join). Result == baseline.
- **`where hasP or x > 5`** → flag inside a non-probe conjunct → `demanded`
  gains `flagId` → **NO fire**. (The flag's truth does not partition rows.)
- **`select c.*, hasP … where hasP`** (flag also selected) → projection puts
  `flagId` in `demanded` → **NO fire** (retain).
- **`select * … where hasP`** / **`select c.*, p.col … where hasP`** (right
  column demanded) → right attr in `demanded` → **NO fire** (this is the
  deferred outer→inner conversion, not a semi-join shape).
- **Two existence specs on the join** (one probed, one selected) → `existence
  .length !== 1` → **NO fire**.
- **`where not not hasP`** → `normalizePredicate` collapses to `hasP` → `semi`.
- **`where hasP = true` / `= false`** → semi / anti via literal detection
  (if implemented per Q2).
- **Residual ON condition** (`on p.pk = c.fk and p.active`): semi/anti carries
  the full condition; IND folders abstain on the non-equi conjunct → plain
  semi/anti survives (still a win). Result == baseline.
- **FK-covered cascade**: `semi` over a covering FK→PK with row-preserving R →
  `semi-join-fk-trivial` folds to `L` (NOT NULL FK) or `Filter(L, fk IS NOT
  NULL)` (nullable FK); `anti` over a covering NOT-NULL FK → `anti-join-fk-empty`
  folds to `Empty`. Assert the full collapse on FK shapes.
- **Non-FK shape** (no covering FK, or filtered/limited R) → plain `semi`/`anti`
  survivor; assert a physical semi/anti join (hash semi-join) and result-equality.
- **Impure R subtree** → `subtreeHasSideEffects(join.right)` guard → **NO fire**.
- **Nullable vs NOT-NULL FK column** → exercise both (semi: L vs Filter(L);
  anti: empty only for NOT-NULL).
- **Termination**: the rewrite output is a `semi`/`anti` join with no existence
  spec; re-running the rule no-ops (anchor requires a flag-bearing `left` join
  below). No rewrite loop.
- **Result equality vs the rule-disabled baseline** for EVERY shape above — rows
  byte-identical (use a `resultsNoRecovery` helper that disables
  `semijoin-existence-recovery`, mirroring `resultsNoPrune`).
- **Write-through-view**: a flag only in `where` is never a routing-Project
  target (Q7) — no UPDATE/INSERT path reaches the rewrite; spot-check with a
  view if a writable-view existence fixture exists, else cover by the
  by-construction argument in the docstring.

## TODO

### Phase 1 — Rule implementation
- Create `rule-semijoin-existence-recovery.ts` with `ruleSemijoinExistenceRecovery`
  per the algorithm above; a module docstring covering Q1–Q7 (mirror the
  `join-existence-pruning` docstring's structure: anchor rationale, demand-shape
  proof, mapping table, sole-spec decision, residual-condition soundness, NULL
  partition, write-half-by-construction, `sideEffectMode` rationale).
- Implement `chainWalk` (or reuse `walkChain` + a re-scan), `findSoleProbe`
  (probe normal-form matcher over `normalizePredicate`d conjuncts), and
  `rebuildChainStrippingProbe`. Reuse `collectAttrIds` / `rebuildProject` /
  `ChainEntry` from `rule-join-elimination.ts`; `splitConjuncts` /
  `combineConjuncts` from `analysis/predicate-conjuncts.ts`.
- Register in `optimizer.ts` (Structural, Project, priority 23, `sideEffectMode:
  'aware'`) with a comment documenting the 22<p<26 ordering window.

### Phase 2 — Tests
- New `test/optimizer/rule-semijoin-existence-recovery.spec.ts`. Copy the harness
  from `rule-join-existence-pruning.spec.ts` (`planRows`, `joinCount`,
  `hasPhysicalJoin`, `joinExistence`, `results`, and a `resultsNoRecovery`
  baseline that adds `'semijoin-existence-recovery'` to `disabledRules`).
- Cover every row of the Edge cases section: semi/anti happy paths (flag gone
  from the plan, semi/anti node present), residual-AND split, the four NO-fire
  rejections (OR-probe, flag-selected, right-col-demanded, two-flag), FK-folding
  cascade (NOT-NULL → L/Empty; nullable → Filter(L)), non-FK plain-survivor,
  `not not` normalization, impure-R guard, and result-equality vs
  `resultsNoRecovery` for each shape.
- Add a `.sqllogic` (or extend an existing join/exists logic file) asserting
  result-equality on representative semi & anti queries against real data.

### Phase 3 — Validate & document
- `yarn workspace @quereus/quereus build`, then `run lint`, then `test` — stream
  with `2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`. All green; no regressions.
- Update `docs/optimizer.md` (add the rule to the Structural catalog, noting it
  is the demand-SHAPE complement of `join-existence-pruning`'s demand-PRESENCE
  prune, and the semi/anti → IND-folding cascade).
- Update `docs/view-updateability.md` existence-flag section to note the
  probe-only flag is recovered to a semi/anti join (and why that is write-safe by
  construction).
- `test:store` is not required (pure plan-level rewrite, no storage interaction);
  state that in the handoff.

### Deferred (file the backlog tickets — already created by the plan stage)
- `semijoin-existence-recovery-aggregate-anchored` — Aggregate-anchored variant
  (`select count(*) … where hasP`). Keep `chainWalk` anchor-agnostic to make it a
  prologue/epilogue mirror.
- `outer-to-inner-join-under-flag-probe` — `where hasP` with right columns
  selected ⇒ rewrite `left join` to `inner join` (keeps right columns), distinct
  from semi/anti.
- `existence-probe-richer-forms` — `case when hasP …`, `hasP is [not] true`,
  `hasP is [not] false` probe detection.
