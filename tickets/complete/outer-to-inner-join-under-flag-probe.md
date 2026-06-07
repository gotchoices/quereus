description: Recover an `inner join` from a `left join … exists right as <flag>` when the flag is a POSITIVE top-level probe (`where <flag>`) AND ≥1 right-side column is demanded above the join (the demand-SHAPE complement of `semijoin-existence-recovery`). Implemented as `ruleInnerJoinExistenceRecovery`; reviewed and completed.
files: packages/quereus/src/planner/rules/join/rule-inner-join-existence-recovery.ts (NEW rule), packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (exports analyzeChain/classifyProbe/rebuildChainStrippingProbe/ProbeMatch; Q2 doc corrected), packages/quereus/src/planner/optimizer.ts (registration, priority 23), packages/quereus/test/optimizer/rule-inner-join-existence-recovery.spec.ts (NEW, +2 star cases), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (flipped-case baseline strengthened), packages/quereus/test/logic/08.3-existence-flag-inner-recovery.sqllogic (NEW), docs/optimizer.md
----

## What landed (summary)

A Structural-pass rule `ruleInnerJoinExistenceRecovery` (id
`inner-join-existence-recovery`, priority 23, `sideEffectMode: 'aware'`,
registered immediately after the `semijoin-existence-recovery` block) that
rewrites a flag-bearing `left join … exists right as <flag>` to a plain **inner
join** when the sole existence flag is a **positive** top-level probe
(`probe.polarity === 'semi'`) and **≥1 right-side column is demanded** above the
join. This is the demand-SHAPE complement of the semi rule: the semi rule
abstains exactly when a right column is demanded; this rule fires there and
produces an inner join (which keeps the right columns a semi join would drop).

Soundness: `emitLoopJoin` drives `left join … exists right as` as a normal left
join + one appended flag bit; a positive `where flag` keeps exactly the K matched
rows per left row, identical row-for-row to an inner join on the same condition —
for **any** condition. So (unlike the semi rule) no fan-out guard, no
condition-shape restriction, no NOT-NULL-FK requirement. `buildJoinAttributes`
emits right attribute ids verbatim for both `left` and `inner` (only nullability
differs), so right columns resolve at the same ids; the non-nullable right typing
is a sound strengthening.

The implementer's handoff, soundness argument, and the disjointness-with-the-semi-rule
partition all hold up under review (see findings below).

## Review findings

**Diff reviewed first, fresh, before the handoff** (`git show aef19af8`): the new
rule, the shared-export refactor of the semi rule, optimizer registration, both
specs, the 08.3 sqllogic, and docs/optimizer.md. Then verified against the actual
source of `buildJoinAttributes`, `walkChain`/`analyzeChain`, `EXISTENCE_FLAG_TYPE`,
and star expansion.

### Correctness / soundness — checked, no defects

- **Row-for-row equivalence** (`where flag` over the nested-loop left join ≡ inner
  join) re-derived for fan-out (K matches kept, not collapsed), residual/non-equi
  ON conditions (carried verbatim), and NULL-FK rows (unmatched under both plans).
  Confirmed end-to-end by the 08.3 sqllogic against real data and by every spec's
  `resultsNoRecovery` baseline.
- **Attribute-id / nullability preservation**: verified `buildJoinAttributes`
  (`join-utils.ts`) takes right attr ids verbatim for both `left` and `inner`;
  only the `nullable` flag differs. Right columns resolve by id; dropping the
  appended flag shifts nothing. Confirmed by passing result-equality assertions.
- **Disjointness with `semijoin-existence-recovery`** re-derived over the full
  6-cell truth table (probe polarity × right-col-demanded × R-unique). The two
  rules call the *pure* `analyzeChain(node, chain, flagId)` independently → same
  `demanded`/`probe`; the semi rule's right-col check runs *before* its fan-out
  guard, so positive-probe + right-col + non-unique-R cleanly abstains in semi and
  fires in inner. **Never both, never the wrong one.** The only "neither" cell
  (positive probe, NO right col, fan-out R) is the intended parked fallback.
- **Impure-R guard** (`subtreeHasSideEffects(join.right)` → abstain, `'aware'`
  mode) is sufficient: it is the recovery site, dropping the flag re-enables
  `join-physical-selection` (the only place R's scan count can change). Mirrors the
  sibling. Left side needs no guard (execution count unchanged).
- **Termination**: output inner join has no existence spec → re-run sees
  `joinType !== 'left'` and no-ops.
- **Type safety / error handling / cleanup**: no `any`; `existence!` guarded by
  `hasExistenceColumns`; abstains (returns null) with `log()` on every non-match;
  pure plan rewrite, no resources. Clean.

### Findings fixed inline (minor)

1. **`select *` reasoning in the handoff was backwards — and the semi rule's Q2
   doc comment was stale.** The handoff claimed the `exists … as` flag is *excluded*
   from `*` expansion. Empirically (verified via a throwaway plan probe, since
   removed) the opposite is true: `buildStarProjections` expands
   `source.getAttributes()`, which for a flag-bearing join **includes** the flag —
   so unqualified `select * … where flag` demands the flag, `!demanded.has(flagId)`
   fails, and the rule **abstains, staying a left join** (output even carries
   `hasP:true`). This is the *correct* behavior (the user selected the flag via
   `*`), only the stated reasoning was inverted. `select c.*, p.col` *does* recover
   (qualified `c.*` filters by relation name, omitting the appended flag; `p.col`
   demands a right col). **Fix:** corrected the semi rule's Q2 doc comment (it had
   lumped `select *` into "the deferred outer→inner-conversion case"), and added two
   lock-down cases to the new spec — `select c.*, p.pv … where hasP` ⇒ inner, and
   `select * … where hasP` ⇒ stays left with the flag retained (rows incl. `hasP`).

2. **Flipped semi-spec test had a near-tautological row baseline.** The flipped
   case in `rule-semijoin-existence-recovery.spec.ts` (right column demanded ⇒
   inner) compared against that spec's `resultsNoRecovery`, which disables ONLY the
   semi rule — leaving the inner rule live, so its "baseline" was itself the
   inner-recovered plan. **Fix:** that test now computes a genuine baseline with
   **both** recovery rules disabled (true nested-loop+flag) and asserts the literal
   expected rows. (The strong baseline already lived in the new spec; this closes
   the weaker assertion the implementer flagged.)

### Verified out-of-scope / intended deferrals (no action)

- **No-right-col fan-out fallback** (positive probe, no right col, non-unique R —
  where neither recovery rule fires) is correctly parked; the ticket exists at
  `tickets/plan/inner-join-recovery-fanout-fallback.md` (promoted to plan; the
  handoff's "backlog/" path was stale, the ticket is present and tracked).
- **Aggregate anchor** (`count(*) … where flag`, Project-less) — out of scope,
  consistent with the sibling's documented deferral.
- **USING / RIGHT / FULL / inner origin** are sound, *unreachable* abstentions by
  construction: `!join.condition` excludes USING (condition is undefined for USING
  joins — verified in `building/select.ts`); `joinType === 'left'` excludes
  RIGHT/FULL/inner/cross; the parser rejects `exists … as` on inner/cross. Not
  separately testable (the constructs can't be built), so no no-fire tests added —
  the guards are genuinely unreachable, not silently mis-firing.

### Major findings → new tickets

**None.** All findings were minor and fixed in this pass; no new fix/plan/backlog
tickets filed.

## Validation performed (all green, this review)

- `yarn workspace @quereus/quereus run lint` — exit 0, no output.
- New inner spec + semi spec (after edits) — **48 passing** (was 46; +2 star
  cases; flipped test strengthened in place).
- Full sqllogic suite (`logic.spec.ts`, includes 08.3) — **228 files passing**,
  exit 0.
- Full quereus suite (`test-runner.mjs`) — **5138 passing, 9 pending**, exit 0
  (+2 vs the implement baseline of 5136, accounting for the new star tests; no
  regressions).
