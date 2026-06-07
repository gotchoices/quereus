description: Review the new `semijoin-existence-recovery` optimizer rule — recovers a semi/anti join from a `left join … exists right as <flag>` whose flag is demanded ONLY as a pure top-level boolean probe (`where flag` ⇒ semi, `where not flag` ⇒ anti). Pure optimization; rows must be byte-identical to the nested-loop+flag baseline. Implementation is complete, build/lint/full-suite green.
prereq:
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (NEW — the rule), packages/quereus/src/planner/optimizer.ts (registration, Structural/Project/priority 23/aware), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (NEW — 19 cases), packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic (NEW — e2e), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (one case updated — see below), docs/optimizer.md, docs/view-updateability.md, packages/quereus/src/planner/rules/join/rule-join-elimination.ts (reused walkChain/collectAttrIds/rebuildChain/rebuildProject/ChainEntry — unchanged), packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts + rule-anti-join-fk-empty.ts (downstream IND folders the recovery threads into — unchanged)
----

## What was built

A new Structural rule `ruleSemijoinExistenceRecovery` (id `semijoin-existence-recovery`),
anchored on `ProjectNode`. It is the demand-**SHAPE** complement of
`join-existence-pruning`'s demand-**PRESENCE** prune: pruning drops a flag *nothing*
reads; recovery rewrites the join when the sole `exists … as` flag on a `left join`
is demanded but **only** as a top-level boolean existence probe.

```sql
select c.* from child c left join parent p on p.pk = c.fk exists right as h where h;     -- ⇒ semi(child, parent, p.pk = c.fk)
select c.* from child c left join parent p on p.pk = c.fk exists right as h where not h; -- ⇒ anti(child, parent, p.pk = c.fk)
```

The recovered semi/anti is the same node shape `ruleSubqueryDecorrelation` emits, so it
re-opens physical join selection (hash semi-join) and threads into the IND-folding
cascade (`semi-join-fk-trivial` / `anti-join-fk-empty`) in the same top-down descent.

### Key design decisions (all settled in the implement ticket, verified in code)

- **Project anchor, not Filter** (Q1). A Filter anchor is unsound: rewriting the join to
  semi drops the right columns + flag, and only the enclosing Project's projection list
  can prove nothing above references them. The probe Filter is reached via `walkChain`
  and rewritten in place.
- **Demand-SHAPE proof** (Q2): demand built conjunct-by-conjunct so the single probe
  conjunct is excluded; requires (a) exactly one flag-referencing conjunct in probe
  normal form, (b) flag absent from residual demand (selected/sorted-on flag abstains),
  (c) no right-side column demanded (`select *` / right-col-selected abstain — the
  deferred outer→inner case), (d) `existence.length === 1`, (e) impure-R guard.
- **Probe normal forms**: `f` (semi), `not f` (anti), `f = true`/`true = f` (semi),
  `f = false`/`false = f` (anti) — each via `normalizePredicate` first, so `not not f`
  collapses. `IS [NOT] TRUE/FALSE` and `case`-wrapped forms are deferred.
- **Condition carried verbatim** (Q5): `left join … where f` keeps exactly the L rows
  with ∃ a matching R row = `semi(L,R,condition)` for *arbitrary* condition; the rule
  does NOT itself require AND-of-equalities (the IND folders gate on that and abstain on
  residuals, leaving a plain semi/anti — still a win).
- **`sideEffectMode: 'aware'`** + `subtreeHasSideEffects(right)` guard (a semi join
  short-circuits the R scan, changing R's execution count).
- **Registration order is load-bearing** (pass rules fire in REGISTRATION order, not by
  `priority` — see optimizer.ts comment). Placed after `join-existence-pruning` and
  before `fanout-lookup-join` / `join-elimination` / the IND folders.

## How to validate / use cases (the test floor)

`yarn workspace @quereus/quereus test` → **5065 passing, 0 failing** (full suite). Build
and lint clean. The new coverage:

- **`test/optimizer/rule-semijoin-existence-recovery.spec.ts`** (19 cases): semi/anti
  happy paths (flag gone, physical semi/anti present), `not not`, `= true`/`= false`,
  residual-AND split, FK NOT-NULL cascade (semi→L with zero join ops; anti→Empty/zero
  rows), FK nullable cascade (semi→Filter(L, fk IS NOT NULL); anti does NOT fold, stays
  physical anti), and five NO-fire rejections (OR-probe, flag-selected, right-col-demanded,
  flag-sorted-on, two-demanded-flags), the prune-then-recover interaction (undemanded
  sibling flag dropped first, sole survivor then recovered), and no-op-when-disabled.
  Every shape also asserts result-equality vs a `resultsNoRecovery` baseline (only the
  recovery rule disabled).
- **`test/logic/08.2-existence-flag-semijoin-recovery.sqllogic`**: end-to-end
  result correctness (parse → plan → optimize → recover → execute) for the same shapes
  against real data.

Run just these:
`yarn workspace @quereus/quereus test --grep 'ruleSemijoinExistenceRecovery|08.2-existence' --reporter spec`

## Honest gaps / where to look hardest

1. **Updated a `join-existence-pruning` spec case (not pre-existing — caused by this
   rule).** `rule-join-existence-pruning.spec.ts` had "retained when referenced only in a
   WHERE filter above the join" using `where hasP`, which asserted the *old* limitation
   that a probe-only WHERE pins the flag. This rule lifts exactly that limitation, so the
   case now recovers a semi join (flag gone). I changed the query to `where hasP or c.cv > 150`
   (a NON-probe shape) so the case still tests the pruning rule's WHERE-demand folding
   without overlapping recovery, and updated the expected rows. **Reviewer: confirm this
   is the right call vs. repurposing the test to assert recovery.** No other existing
   tests changed.

2. **Impure-R guard is not exercised at runtime.** The right side of a `left join` is a
   read-only table reference; constructing an impure R via plain SQL isn't possible, so
   the `subtreeHasSideEffects(join.right)` guard is covered only by the by-construction
   argument (mirrors `subquery-decorrelation`). If you know a way to inject a
   side-effecting right subtree, a direct test would be welcome.

3. **`below`-chain path lightly covered.** `rebuildChainStrippingProbe` splits the chain
   into entries above/below the probe filter and reuses `rebuildChain` for each. In
   practice the WHERE filter is closest to the join, so `below` is empty in all tests
   (the `above` path with a Sort, and the omit-vs-residual filter rebuild, ARE covered).
   The `below` branch is symmetric and reuses the battle-tested `rebuildChain`, but a
   plan with a pass-through node *between* the probe Filter and the Join is not directly
   asserted. Low risk; worth a skeptical read.

4. **`f = true`/`= false` depends on boolean-literal representation.** Verified that
   `true`/`false` parse to `value: true/false` (boolean) in expression position and
   constant-folding does not rewrite `flag = true`; both probe forms pass. If a future
   peephole simplifies `x = true → x`, `classifyProbe`'s `f = true` arm becomes dead but
   the `f` arm still covers it — no correctness risk, just note the coupling.

5. **No `test:store` run.** Pure plan-level rewrite, no storage interaction — not
   required (per the implement ticket). The sqllogic exercises the memory vtab path.

## Deferred (backlog tickets already filed by the plan stage)

- `semijoin-existence-recovery-aggregate-anchored` — the `count(*) … where flag` variant
  (no enclosing Project). `walkChain` is anchor-agnostic, so this is a prologue/epilogue
  mirror.
- `outer-to-inner-join-under-flag-probe` — `where flag` with right columns selected ⇒
  rewrite `left join` to `inner join` (keeps right columns), distinct from semi/anti.
  This rule deliberately abstains on that shape (check (c)).
- `existence-probe-richer-forms` — `case when flag …`, `flag is [not] true/false`.
