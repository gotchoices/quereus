description: Aggregate-anchored variant of `semijoin-existence-recovery`. Adds `ruleSemijoinExistenceRecoveryUnderAggregate` — a second entrypoint anchored on `AggregateNode` for the flag-bearing `left join … exists right as <flag>` that sits under a `count(*)` / `group by` with no enclosing Project (e.g. `select count(*) from child c left join parent p on … exists right as hasP where hasP`). The probe Filter sits between the Aggregate and the Join, so the SAME probe-detection + chain-rewrite machinery applies; only the demand prologue (group-by + aggregate expressions) and the rebuild epilogue (reconstruct the `AggregateNode` with `preserveAttributeIds`) differ. Mirrors how `ruleJoinExistencePruningUnderAggregate` extended `ruleJoinExistencePruning`.
prereq: semijoin-existence-recovery
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (ruleJoinExistencePruningUnderAggregate precedent), packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate precedent + shared chain helpers), packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, docs/optimizer.md
----

## Context

The base `semijoin-existence-recovery` rule shipped and is reviewed/complete (see
`tickets/complete/semijoin-existence-recovery.md`). It is `ProjectNode`-anchored:
it rewrites a probe-only `exists right as <flag>` on a `left join` into a semi
(`where flag`) or anti (`where not flag`) join, re-opening physical join selection
and the FK/IND-folding cascade.

That anchor never fires for a **bare aggregate** query — `select count(*) from … where hasP`
plans as an `AggregateNode` with **no enclosing Project**, so the probe Filter and
the flag-bearing join sit *under* the Aggregate and the Project entrypoint walks
right past them. This ticket adds the Aggregate entrypoint, exactly mirroring the
two existing aggregate-anchored siblings:

- `ruleJoinExistencePruningUnderAggregate` (`rule-join-existence-pruning.ts:127`) —
  the demand prologue and epilogue precedent (group-by + aggregate exprs;
  `new AggregateNode(scope, src, groupBy, aggregates, undefined, getAttributes())`).
- `ruleJoinEliminationUnderAggregate` (`rule-join-elimination.ts:332`) — same
  prologue/epilogue, plus the `isRelationalNode(newSource)` guard pattern.

## Design (fully resolved — no open questions)

### Shape that must be recovered

```
Aggregate(count(*))                         Aggregate(count(*))
  Filter(hasP)              ─────────▶         SemiJoin(L, R, cond)   -- where hasP  (semi)
    Join[left, exists hasP]                     AntiJoin(L, R, cond)   -- where not hasP (anti)
      L
      R
```

`walkChain(node.source, …)` (shared, in `rule-join-elimination.ts`) already walks
the whitelisted pass-through chain (Filter/Sort/Limit/Distinct/Alias) from the
Aggregate's source down to the first `JoinNode` — the probe Filter is just a
`filter` chain entry, identical to the Project case. The flag-bearing join, the
sole-spec / `left` / `side==='right'` gates, the demand-SHAPE proof, the fan-out
guard (semi only), the impure-R guard, and the probe-strip rebuild are **all
unchanged** from the Project rule. Only the demand seed and the top-of-tree
rebuild differ.

### Shared-helper refactor: `analyzeChain` takes a pre-seeded demand set

`analyzeChain` currently hardcodes its demand seed from a `ProjectNode`:

```ts
export function analyzeChain(project: ProjectNode, chain, flagId): … {
  const demanded = new Set<number>();
  for (const proj of project.projections) collectAttrIds(proj.node, demanded);
  …walk chain, fold non-probe conjuncts + sort keys into `demanded`, locate probe…
}
```

The Aggregate anchor seeds `demanded` from a different scalar-child set (group-by
exprs + each aggregate expression), so lift the seed out of `analyzeChain` and
pass the already-seeded set in. This keeps the substantial conjunct-walking /
probe-classification logic DRY across all three callers:

```ts
export function analyzeChain(demanded: Set<number>, chain, flagId): … {
  // `demanded` is pre-seeded by the caller from its anchor's scalar children.
  …walk chain (UNCHANGED) …
}
```

Each entrypoint inlines its own 1–3 line seed loop (matching how the
pruning/elimination aggregate siblings each inline their seed loops):

- `ruleSemijoinExistenceRecovery` (Project) and `ruleInnerJoinExistenceRecovery`
  (Project): seed from `node.projections` (`collectAttrIds(proj.node, demanded)`).
  **Both call sites must be updated** — `ruleInnerJoinExistenceRecovery` imports
  `analyzeChain` from this module.
- `ruleSemijoinExistenceRecoveryUnderAggregate` (Aggregate, new): seed from
  `node.groupBy` (each is a `ScalarPlanNode`) + `node.aggregates` (each
  `agg.expression`), exactly as the two aggregate siblings do.

Keep the return shape `{ demanded, probe } | null` so the existing destructuring
in both Project callers is unchanged.

### New rule body (mirror of the Project rule)

```ts
export function ruleSemijoinExistenceRecoveryUnderAggregate(node, _ctx) {
  if (!(node instanceof AggregateNode)) return null;

  const walk = walkChain(node.source, new Set<number>());   // throwaway demand set
  if (!walk) return null;
  const { join, chain } = walk;

  // SAME gates as the Project rule:
  if (join.joinType !== 'left') return null;
  if (!join.hasExistenceColumns) return null;
  const existence = join.existence!;
  if (existence.length !== 1) return null;
  const spec = existence[0];
  if (spec.side !== 'right') return null;
  if (!join.condition) return null;
  const flagId = spec.attrId;

  // Demand prologue — the ONLY divergence from the Project rule.
  const demanded = new Set<number>();
  for (const g of node.groupBy) collectAttrIds(g, demanded);
  for (const a of node.aggregates) collectAttrIds(a.expression, demanded);

  const analysis = analyzeChain(demanded, chain, flagId);
  if (!analysis) return null;
  const { probe } = analysis;            // `demanded` is the same set we passed in

  if (demanded.has(flagId)) return null;                       // flag demanded elsewhere
  const rightAttrIds = join.right.getAttributes().map(a => a.id);
  for (const id of rightAttrIds) if (demanded.has(id)) return null;  // right col demanded

  if (probe.polarity === 'semi' && !rightMatchesAtMostOne(join)) return null;  // fan-out guard
  if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) return null;  // impure-R guard

  const semiAnti = new JoinNode(join.scope, join.left, join.right, probe.polarity, join.condition);
  const newSource = rebuildChainStrippingProbe(chain, probe, semiAnti);

  // Rebuild epilogue — the ONLY other divergence (mirror the two aggregate siblings).
  if (!isRelationalNode(newSource)) {
    throw new Error('rule-semijoin-existence-recovery-aggregate: rebuilt source must be relational');
  }
  return new AggregateNode(
    node.scope, newSource, node.groupBy, node.aggregates,
    undefined,            // estimatedCostOverride
    node.getAttributes(), // preserveAttributeIds — keep the Aggregate's output ids stable
  );
}
```

Add imports to `rule-semijoin-existence-recovery.ts`: `AggregateNode`
(`../../nodes/aggregate-node.js`) and `isRelationalNode` (`../../nodes/plan-node.js`).
`rebuildChainStrippingProbe` already returns a `RelationalPlanNode`, so the
`isRelationalNode` check is belt-and-suspenders parity with the siblings — keep it
for symmetry with `ruleJoinExistencePruningUnderAggregate`.

### Registration (`optimizer.ts`)

Add to the `ruleSemijoinExistenceRecovery` import on line 35:
`import { ruleSemijoinExistenceRecovery, ruleSemijoinExistenceRecoveryUnderAggregate } from …`.

Register a new Structural rule **in registration order after
`join-existence-pruning-aggregate` (priority 22) and before the Join-typed IND
folders `anti-join-fk-empty` / `semi-join-fk-trivial` and
`join-elimination-aggregate` (all priority 26)**. The natural slot is immediately
after the `inner-join-existence-recovery` registration block (≈ line 452, before
`fanout-lookup-join`), mirroring its Project siblings:

```ts
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'semijoin-existence-recovery-aggregate',
  nodeType: PlanNodeType.Aggregate,
  phase: 'rewrite',
  fn: ruleSemijoinExistenceRecoveryUnderAggregate,
  priority: 23,
  // Recovers a semi/anti join under an Aggregate — short-circuits R's scan at
  // the first match (semi), changing R's execution count. Same impure-R refusal
  // as the Project entrypoint.
  sideEffectMode: 'aware',
});
```

No nodeType collision with the Project `semijoin-existence-recovery` (Project vs
Aggregate). Pass rules fire in **registration order** (priority is documentation),
so this placement realizes: prune undemanded sibling flags first (22) → recover
the sole survivor here (23) → the recovered semi/anti threads into
`anti-join-fk-empty` / `semi-join-fk-trivial` and `join-elimination-aggregate`
(26) in the SAME `applyRules` loop. This is the aggregate analogue of why the
Project semi rule sits between `join-existence-pruning` and the IND folders.

## Edge cases & interactions

- **HAVING above the Aggregate does not block.** `having count(*) > 0` is a
  `FilterNode` *above* the Aggregate; it can only reference the Aggregate's outputs
  (group keys / aggregate results), never the raw flag, and the rule fires on the
  AggregateNode looking only downward — so it never appears in `walkChain` and needs
  no handling. Mirror the explicit HAVING note in `ruleJoinExistencePruningUnderAggregate`'s
  header. **Test:** `select count(*) … where hasP having count(*) >= 0` still recovers
  a semi join and returns the baseline count.
- **`group by` on the flag retains it.** `select hasP, count(*) … group by hasP`
  seeds `flagId` into `demanded` via `groupBy`, so `demanded.has(flagId)` abstains
  (flag is genuinely demanded). **Test:** flag retained, `joinType === 'left'`,
  result equals baseline.
- **Aggregate over a right column retains the join / abstains.**
  `select count(p.pv) … where hasP` seeds a right attr id into `demanded` (via the
  aggregate expression), so the right-column-demanded check abstains — the semi
  shape (left columns only) can't satisfy it. There is **no aggregate-anchored inner
  fallback** in scope (the `count(*) … where hasP` shape is the target; the
  reachability note rules out the inner-only cardinality cascade), so the join
  correctly stays a flag-bearing `left` join — sound, just unoptimized. **Test:**
  `joinType === 'left'`, flag retained, result equals baseline. (If a real workload
  ever wants this optimized, file a follow-up for an aggregate inner fallback — out
  of scope here.)
- **Fan-out R under a positive probe abstains with no fallback.**
  `select count(*) from fchild c left join fparent p on p.pp=c.cc exists right as h where h`
  where `c.cc=1` matches 3 `fparent` rows: the flag-bearing left join yields 3 rows
  for `cc=1`, so a semi join would (wrongly) collapse to 1 and the `count(*)` would
  be wrong. The shared `rightMatchesAtMostOne` fan-out guard abstains (semi only),
  and — unlike the Project case — there is no aggregate inner fallback, so the join
  stays `left`. **Test:** `joinType === 'left'`, flag retained, `count(*)` equals the
  both-recovery-rules-disabled baseline (the fanned-out count, NOT the collapsed one).
- **Anti under fan-out still fires.** `where not h` keeps exactly one null-extension
  per unmatched left row regardless of fan-out, so the anti rewrite is exact and the
  fan-out guard is not consulted for it. **Test:** `joinType === 'anti'`, `count(*)`
  equals baseline.
- **Sole-spec / sibling-prune ordering.** `exists right as hasA, exists right as hasB
  where hasB` with `hasA` undemanded: `join-existence-pruning-aggregate` (22) drops
  `hasA` first, leaving a sole `hasB` this rule recovers in a later `applyRules`
  iteration. Two genuinely-demanded flags (e.g. one grouped-on, one probed) →
  `existence.length !== 1` → abstain. **Tests:** both.
- **Probe normal forms carry over verbatim** (shared `classifyProbe`): `hasP`,
  `not hasP`, `not not hasP`, `hasP = true`/`= false`, `is [not] true/false`. At
  least one positive (`hasP`) and one negative (`not hasP`) form under the Aggregate;
  the exhaustive matrix is already covered for the Project anchor and shares the same
  code path — a representative pair suffices here.
- **Residual AND-conjunct under the probe Filter** is split out and retained:
  `where hasP and c.cv > 150` → semi join + a residual `Filter(cv > 150)` rebuilt
  below the Aggregate by `rebuildChainStrippingProbe` (Filter omitted entirely when
  the probe was the sole conjunct). **Test:** count reflects the residual filter and
  equals baseline.
- **Impure-R guard** unchanged (`subtreeHasSideEffects(join.right)`); the
  `sideEffectMode: 'aware'` registration matches the Project rule.
- **Write-half safety by construction** — a flag writable through a view is SELECTed
  by its routing Project (never a bare-aggregate shape), so it is demanded and the
  rule abstains; the aggregate path cannot reach a write. No new surface.
- **Termination** — output is a semi/anti join with no existence spec; re-running the
  rule sees `joinType !== 'left'` (or no flag) and no-ops.
- **No-Project-shape assumption.** The whole rule rests on `select count(*) from …`
  planning as `Aggregate` with no enclosing `Project`. Two shipped sibling rules
  (`…ExistencePruningUnderAggregate`, `…EliminationUnderAggregate`) already depend on
  this exact shape, so it holds — but the implementer should confirm empirically via
  the new tests (a stray Project would make the rule silently never fire; the
  `joinType === 'semi'` plan assertion catches that).

## Tests (extend the existing files)

`packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts` already
has the harness (`planRows` / `joinTypeOf` / `joinExistence` / `results` /
`resultsNoRecovery` / `resultsNoEitherRecovery`) and the `seedExisting` /
`setupFkOrders` / `setupFanOut` fixtures. Add a new
`describe('ruleSemijoinExistenceRecoveryUnderAggregate')` (or a nested
`describe('aggregate anchor')`) reusing those fixtures:

- `count(*) … where hasP` → recovered **semi** (`joinExistence` undefined,
  `joinTypeOf === 'semi'`), `count(*)` equals the no-recovery baseline.
- `count(*) … where not hasP` → recovered **anti**, count equals baseline.
- `count(*) … where hasP having count(*) >= 0` → HAVING does not block; semi
  recovered, count equals baseline.
- `select hasP, count(*) … group by hasP` → flag grouped-on ⇒ retained
  (`joinType === 'left'`), result equals baseline.
- `count(p.pv) … where hasP` → right column demanded ⇒ stays `left`, result equals
  baseline.
- Fan-out (`setupFanOut`): `count(*) … where h` over non-unique R ⇒ semi abstains,
  **no** aggregate inner fallback ⇒ stays `left`; `count(*)` equals
  `resultsNoEitherRecovery` (the fanned-out count). `where not h` ⇒ anti fires,
  count equals baseline.
- Sibling-prune-then-recover and two-demanded-flags abstain, mirroring the Project
  cases.
- Result-equality assertions throughout against the both-anchors-disabled baseline
  (`resultsNoEitherRecovery`) where the inner fallback could otherwise muddy a
  semi-only baseline; against `resultsNoRecovery` where it cannot.

`packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic` — add an
end-to-end aggregate section: a `count(*) … where hasP` returning the matched count
and `count(*) … where not hasP` returning the unmatched count against real seeded
data, plus a fan-out `count(*) … where h` asserting the fanned-out (non-collapsed)
count.

## Docs

Update `docs/optimizer.md`: extend the `semijoin-existence-recovery` rule entry to
note the second `AggregateNode` entrypoint (`semijoin-existence-recovery-aggregate`,
priority 23) for the bare-`count(*) … where flag` shape — exactly as the entry for
`join-existence-pruning` documents its `*-aggregate` sibling. Note the aggregate
anchor has **no** inner fallback (right-col-demanded / fan-out positive probes stay
`left` rather than recovering an inner join, unlike the Project anchor).

## TODO

- Refactor `analyzeChain` in `rule-semijoin-existence-recovery.ts` to take a
  pre-seeded `demanded: Set<number>` instead of a `ProjectNode`; move the
  projection seed loop into `ruleSemijoinExistenceRecovery`.
- Update `ruleInnerJoinExistenceRecovery` (`rule-inner-join-existence-recovery.ts`)
  to seed `demanded` from `node.projections` and pass it to the new `analyzeChain`
  signature.
- Add `ruleSemijoinExistenceRecoveryUnderAggregate` to
  `rule-semijoin-existence-recovery.ts` (import `AggregateNode`, `isRelationalNode`),
  with a header doc block describing the two-entrypoint split (mirror
  `ruleJoinExistencePruningUnderAggregate`'s header).
- Register `semijoin-existence-recovery-aggregate` in `optimizer.ts` (Aggregate
  nodeType, priority 23, `sideEffectMode: 'aware'`, registered after
  `join-existence-pruning-aggregate` and before the priority-26 IND/elimination
  rules); extend the line-35 import.
- Add the aggregate-anchor spec cases to
  `test/optimizer/rule-semijoin-existence-recovery.spec.ts`.
- Add the aggregate end-to-end section to
  `test/logic/08.2-existence-flag-semijoin-recovery.sqllogic`.
- Update the `docs/optimizer.md` rule entry.
- Validate: `yarn workspace @quereus/quereus build`, `yarn lint`, `yarn test`
  (stream with `tee`; the full quereus suite was 5067 passing after the base rule).
