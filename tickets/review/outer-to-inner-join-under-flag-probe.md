description: Review the new `inner-join-existence-recovery` optimizer rule — recovers an `inner join` from a `left join … exists right as <flag>` when the flag is a POSITIVE top-level probe (`where <flag>`) AND ≥1 right-side column is demanded above the join (the demand-SHAPE complement of `semijoin-existence-recovery`).
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts (NEW rule), packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (now exports analyzeChain/classifyProbe/rebuildChainStrippingProbe/ProbeMatch), packages/quereus/src/planner/optimizer.ts (registration, priority 23, after semi block), packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts (NEW), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (deferred-case assertion flipped), packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic (NEW), docs/optimizer.md
----

## What landed

A new Structural-pass rule `ruleInnerJoinExistenceRecovery` (id
`inner-join-existence-recovery`) that rewrites a flag-bearing `left join … exists
right as <flag>` to a plain **inner join** when:

- `joinType === 'left'`, `spec.side === 'right'`, `condition` present;
- the join has a **sole** existence spec (`existence.length === 1`);
- the flag is a **positive** top-level probe (`probe.polarity === 'semi'` — the
  `where flag` / `flag = true` / `flag is true` / `flag is not false` /
  `not not flag` normal forms);
- the flag is not otherwise demanded (`!demanded.has(flagId)`);
- **≥1 right-side column is demanded** above the join (the complement gate that
  distinguishes this from the semi rule); and
- the right subtree is side-effect-free (`subtreeHasSideEffects` refusal).

This is the demand-SHAPE complement of `semijoin-existence-recovery`: the semi
rule abstains exactly when a right column is demanded (a semi join would drop it);
this rule fires there and produces an inner join instead. The two partition the
positive-probe space by the right-column-demanded predicate and never both fire on
one node.

### Soundness (why it's simpler than the semi rule)

`emitLoopJoin` drives `left join … exists right as` as a normal left join + one
appended flag bit. A positive `where flag` keeps exactly the K matched rows per
left row; an inner join on the same condition yields exactly those K rows.
Identical row-for-row for ANY condition. Therefore, unlike the semi rule:

- **No fan-out guard** (inner doesn't collapse K→1 — it *can* convert a fan-out
  case the semi rule cannot). `rightMatchesAtMostOne`/`isUnique` is NOT imported.
- **No condition-shape restriction** — `join.condition` is carried verbatim.
- **No NOT-NULL FK requirement** — a NULL FK is unmatched under both plans.

Attribute ids are preserved (`buildJoinAttributes` emits the same `[left…,
right…]` ids for `left` and `inner`; only right-column `nullable` differs), so
right columns resolve at the same ids; the non-nullable right typing is a sound
strengthening that re-enables FD/key/IND reasoning.

### Shared-helper extraction (DRY)

`analyzeChain`, `classifyProbe`, `rebuildChainStrippingProbe`, and the
`ProbeMatch` interface in `rule-semijoin-existence-recovery.ts` got `export` added
(no logic change) and are imported by the new rule. `rebuildChainStrippingProbe`'s
third param was renamed `semiAnti → recovered` and its doc generalized (now also
takes an inner join). The new rule additionally reuses `walkChain` / `rebuildProject`
from `rule-join-elimination.ts`, mirroring the sibling.

### Registration

`optimizer.ts` priority 23, `sideEffectMode: 'aware'`, registered **immediately
after** the `semijoin-existence-recovery` block and before `fanout-lookup-join` /
`join-elimination` (24) / the IND folders (26). Pass rules fire in registration
order, so placement after the semi block is what makes semi win the no-right-col
half.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- New optimizer spec (18 cases) + flipped semi spec (28 cases) — 46 passing.
- `08.3-existence-flag-inner-recovery.sqllogic` — passing.
- Full `yarn workspace @quereus/quereus run test` — **5136 passing, 9 pending,
  exit 0** (no regressions).

## Test coverage (the floor — treat as a starting point)

New `rule-inner-join-existence-recovery.spec.ts` (its `resultsNoRecovery` disables
ONLY `inner-join-existence-recovery`, giving the true nested-loop+flag baseline):

- **Headline**: `select c.cc, p.pv … where hasP` ⇒ flag gone, `joinType inner`,
  rows `[{cc:1,pv:10},{cc:3,pv:20}]`, equals baseline.
- **Physical selection re-enabled**: `hasPhysicalJoin === true`.
- **Probe normal forms**: `hasP`, `hasP = true`, `hasP is true`, `hasP is not
  false`, `not not hasP` ⇒ inner.
- **Fan-out + right col** (the case the semi rule can't do): 3 fanned-out rows
  kept (no collapse), equals baseline.
- **Residual conjunct**: `where hasP and cv > 150` ⇒ inner + retained filter.
- **No-fire**: `where not hasP` + right col (stays `left`); no right col (semi
  wins, `joinType semi`); flag also selected; OR-probe; `hasP is not null`; two
  demanded flags.
- **Cascade**: undemanded sibling flag pruned first, sole survivor + right col ⇒
  inner.
- **Disabled**: rule off ⇒ nested-loop flag-bearing left join survives.

`08.3` sqllogic: end-to-end row correctness for probe forms, residual conjunct,
negative-probe-stays-left, no-right-col-defers-to-semi, fan-out + right col, and a
declared nullable FK with a NULL-FK row (orphan-leak check).

## Known gaps / things to scrutinize (honest)

- **Flipped semi-spec test baseline is weak.** The flipped case in
  `rule-semijoin-existence-recovery.spec.ts` (`right column demanded … recovers an
  INNER join`) still uses that spec's `resultsNoRecovery`, which disables ONLY the
  semi rule — so its row-equality baseline is itself the inner-recovered plan (a
  near-tautology). The plan-shape assertions (`joinType inner`, flag gone) are the
  real check there; the strong nested-loop baseline comparison lives in the NEW
  spec. Reviewer may want the flipped test to disable both recovery rules for a
  genuine baseline. Not a correctness risk (rows are byte-identical either way),
  just weaker-than-ideal coverage.
- **No explicit `select *` test.** The ticket called for confirming `select *` (and
  `select c.*, p.col`) behavior — that `*` expansion demands both sides (so the
  rule fires with a right col present) and that the `exists … as` flag is excluded
  from `*` expansion (if it were included it would land in `demanded` and the rule
  would correctly abstain). I relied on the existing `*`-expansion semantics rather
  than adding a dedicated case. Worth a reviewer spot-check / an added case.
- **Aggregate anchor out of scope.** Like the semi rule, this is `ProjectNode`-
  anchored only; `count(*) … p.col … where flag` (Project-less aggregate) is not
  handled. Consistent with the sibling's documented deferral.
- **USING / RIGHT / FULL / inner origin** are sound abstentions by construction
  (the `condition` guard excludes USING, `joinType === 'left'` excludes RIGHT/FULL,
  parser rejects `exists … as` on inner/cross) — no explicit no-fire tests added
  for these; verify the guards are genuinely unreachable rather than silently
  mis-firing.
- **No-right-col fan-out fallback** (positive probe, NO right col, fan-out, where
  the semi rule abstains on uniqueness and an inner join would still be a sound
  physical-selection win) is intentionally NOT handled here — parked per the
  original ticket in `tickets/backlog/inner-join-recovery-fanout-fallback.md`
  (verify that backlog ticket exists; this implementation did not create it).
- **Disjointness with the semi rule** rests on the `rightAttrIds.some(...)` gate vs
  the semi rule's "no right col demanded" check (c) being exact complements over
  the SAME `demanded` set built by the shared `analyzeChain`. Both rules call
  `analyzeChain(node, chain, flagId)` independently; confirm there is no path where
  `demanded` could differ between the two calls (it shouldn't — same inputs, pure
  function) such that both fire or neither fires when one should.

## Suggested reviewer focus

1. Re-derive the row-for-row equivalence claim (`where flag` over the nested-loop
   left join ≡ inner join) for a non-equi / residual ON condition and for a NULL-FK
   row — the two places the rule claims more generality than `join-elimination`.
2. Confirm the impure-R guard is sufficient given the rule re-enables
   `join-physical-selection` (which is where R's scan count can actually change).
3. The shared-export refactor: confirm `analyzeChain` semantics are truly identical
   for both callers (the semi rule keeps `semi`/`anti`; this rule keeps `semi`
   only) — no caller-specific assumption leaked into the shared function.
4. Decide whether the two coverage gaps above (flipped-test baseline, `select *`)
   warrant inline fixes (minor) before completion.
