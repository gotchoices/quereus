description: Review the aggregate-anchored variant of existence-flag pruning. New optimizer entrypoint `ruleJoinExistencePruningUnderAggregate` (id `join-existence-pruning-aggregate`, Structural / Aggregate / priority 22 / `sideEffectMode: 'safe'`) drops an unused outer-join `exists … as` flag from a JoinNode reachable through a pass-through chain under an `AggregateNode` — the shape the Project-anchored base rule no-ops on. Pure optimization; an unused flag under an Aggregate was harmlessly computed-and-discarded. Build + full quereus suite (5045 passing) + lint all green; 11 regression tests added.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (new entrypoint + module docstring), packages/quereus/src/planner/optimizer.ts (import line ~34, registration ~line 378), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (new `describe('aggregate-anchored pruning')`, +`resultsNoPruneAgg` helper), docs/optimizer.md, docs/view-updateability.md
----

## What landed

A second entrypoint in `rule-join-existence-pruning.ts`,
`ruleJoinExistencePruningUnderAggregate`, structurally identical to the existing
`ruleJoinExistencePruning` except for the demand-collection prologue (group-by +
aggregate expressions — an `AggregateNode`'s only scalar children) and the
chain-rebuild epilogue (rebuilds the `AggregateNode` with `preserveAttributeIds`
so its output attr ids stay stable). It reuses the same exported
`collectAttrIds` / `walkChain` / `rebuildChain` helpers from
`rule-join-elimination.ts` (no logic duplicated). New imports: `AggregateNode`
and `isRelationalNode`.

Registered in optimizer.ts as `join-existence-pruning-aggregate`
(`PlanNodeType.Aggregate`, `phase: 'rewrite'`, priority 22, `sideEffectMode:
'safe'`) immediately after the Project entrypoint, mirroring how
`join-elimination` (Project, 24) and `join-elimination-aggregate` (Aggregate,
26) are paired. Priority 22 places it before `join-elimination-aggregate` (26)
so a freshly-pruned Aggregate threads into that rule in the same `applyRules`
loop.

`docs/optimizer.md` (the `ruleJoinExistencePruning` entry, now covering both
entrypoints) and `docs/view-updateability.md` (the existence-flag pruning note,
now mentioning both anchors) were updated.

## ⚠️ Important deviation from the ticket — read this

The ticket's **headline** ("`select count(*) from orders left join customers …
exists right as hasC` → prune `hasC`, then `ruleJoinEliminationUnderAggregate`
drops the join → **zero join ops**") is **not achievable**, and the ticket's
premise contains an internal contradiction:

- `exists … as` is **only valid on an OUTER join** — the parser rejects it on an
  inner join ("`'exists ... as'` is not valid on an INNER join (no side is
  null-extended, so the flag would be a constant true)"). So an existence flag
  *always* sits on a LEFT/RIGHT/FULL join.
- `ruleJoinEliminationUnderAggregate` is **inner-only**
  (`if (join.joinType !== 'inner') return null;`).

So pruning an existence flag under an aggregate can re-enable **physical join
selection** (the flag-free LEFT join becomes a HASH JOIN — verified) and the
other guarded rules, but it can **never** cascade into
`ruleJoinEliminationUnderAggregate`. The ticket's "FK-covered inner join feeding
a count(*)" mental model never materializes, because existence flags don't live
on inner joins.

**What this means for the tests.** The `count(*)` aggregate test asserts the
*actual* behavior — flag pruned (`joinExistence === undefined`), physical join
selection re-enabled (`hasPhysicalJoin === true`), and `joinCount === 1` (the
join survives, not eliminated) — with an inline comment pointing at the cause.
The "zero join ops" win requires a separate change, filed as
`tickets/backlog/join-elimination-aggregate-outer-join.md` (extend
`ruleJoinEliminationUnderAggregate` to outer joins — sound for cardinality-only
aggregates; see that ticket for the soundness argument). The pruning rule
delivered here is correct and valuable on its own (re-enables the five guarded
rules); only the *elimination* leg of the headline is deferred.

## Soundness summary (for the adversarial pass to re-check)

- **Demand completeness of the Aggregate anchor.** `AggregateNode.getChildren()`
  is `[source, ...groupBy, ...aggregates.map(a => a.expression)]`. The only
  scalar children — the only places a `ColumnReferenceNode` to the flag's attr
  id can appear — are the group-by and aggregate expressions, which is exactly
  what the prologue scans. A flag attr id absent from `demanded` is provably
  unreferenced by the Aggregate and anything above it (ancestors of the
  Aggregate can only reference its *output* attrs — group keys / aggregate
  results — never the raw flag). Mirrors the Project anchor's completeness.
- **HAVING.** No HAVING field on `AggregateNode`; HAVING is a `FilterNode` above
  the Aggregate that can only reference Aggregate outputs, never the raw flag —
  so it needs no handling. (Test: a `having count(*) > 0` query still prunes an
  otherwise-unused flag.)
- **Middle-flag-drop runtime safety.** Identical to the Project case —
  resolution is by attr id over a `RowDescriptor` rebuilt from
  `getAttributes()`, kept flags' relative order preserved. (Tests: drop-earlier-
  keep-later and keep-middle-drop-both-ends, both reading the surviving flag's
  value correctly via an aggregate arg.)
- **`sideEffectMode: 'safe'`.** Drops only a derived read-only `{true,false}`
  column; both join sides preserved verbatim; the Aggregate is reconstructed
  with identical groupBy/aggregates/output-attrs (pure source swap).
- **Termination.** `kept.length === existence.length` ⇒ return null, so
  re-running on the rule's own output is a no-op (no rewrite loop).
- **Interaction with the Project rule.** A `Project` over an `Aggregate` over a
  flag-bearing join: the Project rule fires on the Project but `walkChain` stops
  at the Aggregate (not a whitelisted pass-through) and no-ops; the Aggregate
  rule handles it. No double-fire.

## Tests added (`describe('aggregate-anchored pruning')`, 11 cases)

All green (file total: 27 passing).

- `count(*)` over FK→PK left join, unused flag → flag pruned, physical join
  selection re-enabled (HASH JOIN), `joinCount === 1`, rows = `[{n:3}]`.
- Contrast: with `join-existence-pruning-aggregate` disabled, the flag survives
  on a nested-loop join (proves the rule is the cause).
- Result equality: pruned `count(*)` == unpruned baseline (both anchors disabled
  via new `resultsNoPruneAgg` helper).
- Flag referenced by an aggregate arg (`sum(case when hasP …)`) → retained,
  `s = 2`.
- Flag is a GROUP BY key (`group by hasP`) → retained, grouping correct.
- Flag referenced only by a WHERE filter under the aggregate → retained
  (walkChain folds it into demand), `n = 2`.
- HAVING-bearing query still prunes an otherwise-unused flag.
- Mixed multi-flag: drop earlier keep later (value correct); three-flag keep-
  middle (value correct); result equality vs baseline.
- Clean no-op when the aggregate sits directly over a base table (no join).

## Known gaps / suggestions for the reviewer

- **No `right`/`full` outer-join aggregate test.** All existence-flag tests in
  this file (original + new) use `exists right as` on a LEFT join. The
  attr-id-based logic is join-type-agnostic, but a `right`-join existence flag
  under an aggregate is unexercised. Low risk, but a candidate for an added
  case.
- **No `group_concat` / ordered-aggregate flag-arg test.** The retained-in-
  aggregate-arg cases use `sum(case when …)`. A flag inside a different
  aggregate kind (e.g. `count(*) filter (where hasP)` if supported, or
  `group_concat`) would broaden coverage of the demand-collection recursion.
- **The deferred elimination cascade** (backlog ticket above) is the main
  follow-up; when it lands, the `count(*)` test's `joinCount === 1` assertion
  flips to `=== 0` and the docs caveat is dropped.
- **`test:store`** was not run (memory-vtab suite only, per the agent default).
  This rule is a pure plan-level rewrite with no storage interaction, so the
  store path is not expected to differ — but it was not exercised.

## Validation (run during implement)

- `yarn workspace @quereus/quereus build` — exit 0.
- `yarn workspace @quereus/quereus test` — **5045 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- Targeted: `rule-join-existence-pruning.spec.ts` — **27 passing**.

## Usage

No surface/API change. Any `count(*)` / `group by` query (or view) over an outer
join carrying an unused `exists [<side>] as <name>` flag — with no enclosing
Project — now gets the flag dropped and physical join selection re-enabled, as if
the flag weren't there. Observable via `query_plan(...)` (`existence` disappears
from the `JoinNode` properties; the join picks up a hash/merge physical variant).
Disable with `tuning.disabledRules = new Set(['join-existence-pruning-aggregate'])`.
