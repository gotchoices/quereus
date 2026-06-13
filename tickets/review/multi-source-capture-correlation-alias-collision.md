description: Review the multi-source per-side UPDATE collision-proof correlation alias (`__vm_self`) work — the capture read-back owning-PK operands and the owning-side strip-to-bare refs are now qualified with the lowered statement's `SELF_ALIAS` (mirroring single-source), so a correlation reference emitted inside a user value subquery binds the lowered target row instead of re-binding to a same-named column in the subquery's own FROM.
prereq:
files:
  - packages/quereus/src/planner/mutation/single-source.ts       # SELF_ALIAS now exported (was module-local); docstring extended for multi-source reuse
  - packages/quereus/src/planner/mutation/multi-source.ts        # imports SELF_ALIAS; capturedValueSubquery gains correlationAlias param; routePartnerRead, owning-strip, np read-back, per-side UPDATE alias
  - packages/quereus/src/planner/building/update.ts              # (unchanged) consumes stmt.alias as the AliasedScope correlation name — verified, no edit needed
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-23 (bug 1), uq-24 (bug 2), uq-25 (composite-PK variant of bug 1)
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` — capture read-back + owning-strip now note __vm_self qualification
difficulty: medium
----

# Multi-source value-subquery correlation refs: `__vm_self` collision-proof alias

## What was built

The multi-source SET-value lowering emitted two kinds of **bare** (unqualified) owning-side
column references that are *intended* to correlate out to the lowered per-side UPDATE's target
row, but rebind to a same-named column when nested inside a user value subquery whose FROM
introduces that name (innermost-scope SQL rules). Both are now qualified with the lowered
statement's synthesised collision-proof alias `SELF_ALIAS = '__vm_self'`, exactly as the
single-source spine already did:

1. **Capture read-back owning-PK operands** (`capturedValueSubquery`, bug 1). The function gained
   a trailing optional `correlationAlias?: string`. When supplied, each PK right operand becomes
   `{ type: 'column', name: pk, table: correlationAlias }` (every conjunct of a composite key
   qualifies); omitted ⇒ bare ⇒ **byte-identical** for `decomposition.ts` and any legacy caller.
   The multi-source per-side callers (`routePartnerRead`, and the non-preserved matched read-back
   at `multi-source.ts:~1513`) pass `SELF_ALIAS`.
2. **Owning-side strip-to-bare** (`stripSideQualifier`'s `substitute`, bug 2). The owning branch
   now returns `{ type: 'column', name: col.name, table: SELF_ALIAS }` instead of a bare column.
3. **Per-side UPDATE carries `alias: SELF_ALIAS`** (`multi-source.ts:~1665`), so the base builder
   (`building/update.ts:136`, `correlationName = stmt.alias?.toLowerCase() ?? tableName`) registers
   `__vm_self` as the target's `AliasedScope` correlation name that the qualified refs bind through.

`SELF_ALIAS` was promoted from a module-local `const` in `single-source.ts` to an `export`, and
its docstring extended to state the multi-source per-side reuse (the same "at most one
`__vm_self`-aliased target in scope" invariant holds: each per-side op is a flat single-table base
UPDATE planned independently, never co-scoped/nested with another lowered target).

**Deliberately left untouched** (per the plan, and verified): `buildCapturedKeyPredicate`
(`multi-source.ts:~1900` — top-level WHERE operands, never nested in a user subquery; shared by the
existence-DELETE and RETURNING re-query paths we are not aliasing), the existence-DELETE statement,
and the null-extended materialize INSERT (an INSERT has no target-row scan to correlate to). The
`decomposition.ts` callers all use the 3-arg `capturedValueSubquery(...)` form ⇒ byte-identical.

## Validation performed

- **`yarn workspace @quereus/quereus test`** (full suite): **6077 passing, 0 failing, 9 pending.**
- **`yarn lint`**: clean. **`yarn typecheck`** (`tsc --noEmit`): clean.
- **Regression-reality check (the important one):** temporarily neutered each fix in isolation and
  re-ran the 93.4 suite to confirm the new tests fail loudly on the unfixed code:
  - With the `capturedValueSubquery` PK qualification neutered, **uq-23 fails** (bug 1).
  - With the owning-strip qualification neutered, **uq-24 fails** with `realval=9` vs expected `6`
    — the exact rebind to `uq24_t.realval=999` → `max(x<999)=9`. Both fixes restored after.

## Use cases / what to scrutinize

- **uq-23 (bug 1 — capture read-back owning-PK collision).** View `uq23_v` over `uq23_c c join
  uq23_p p`; the value subquery's FROM (`uq23_t`) has a `cid` column colliding with the owning PK.
  `update … set cval = (select max(x) from uq23_t where x < pv) where cid = 2` — the partner read of
  `pv` lowers to a capture read-back nested inside the user subquery; its `cid` operand must
  correlate to `uq23_c` (=2) via `__vm_self`, not rebind to `uq23_t.cid` (=99). Expected
  `[{cid:1,cval:1},{cid:2,cval:150}]` (max of {50,150} under 200).
- **uq-24 (bug 2 — owning strip-to-bare collision).** A **rename** `c.realval as cval`; the value
  subquery's FROM (`uq24_t`) has the **base** name `realval`. `set cval = (select max(x) from uq24_t
  where x < cval)` — the descent substitutes `cval`→`c.realval`, and the strip must yield
  `__vm_self.realval` (target row, realval=7), not bare `realval` (rebinds to `uq24_t.realval`=999).
  Expected `[{cid:1,realval:5},{cid:2,realval:6}]`. **Note the rename is essential**: if the view
  column name equaled the base name, `makeViewColumnDescend`'s shadow logic would leave it local
  (user intent) and the strip would never fire — that's the already-correct over-qualification guard.
- **uq-25 (composite-PK variant of bug 1).** Owning side `uq25_c` has a 2-column PK `(c1, c2)`,
  both colliding with `uq25_t.c1/c2` (=99). Exercises the per-conjunct qualification — every
  equality's right operand must carry `__vm_self`.

## Honest gaps / reviewer attention

- **uq-23's unfixed failure mode differs from the plan's prediction.** The plan predicted bare `cid`
  → NULL read-back → `cval` *silently becomes NULL*. The observed unfixed behavior is actually a
  louder `ConstraintError: NOT NULL constraint failed: uq23_c.cval` (cval is declared nullable, so
  the exact mechanism by which the broken nested correlation surfaces as a NOT NULL violation was not
  run to ground — it may be worth a glance, though it does not affect test validity). The **fixed**
  result (`cval=150`) can only arise from the correct `__vm_self.cid`→`uq23_c.cid=2`→captured `pv=200`
  correlation, so the test is genuinely discriminating either way. If a reviewer wants the comment in
  uq-23 to read precisely, it currently says "wrong/NULL result" — accurate but does not name the
  constraint-error surface.
- **Plan-identity, not byte-identity.** For every non-colliding statement the only change is an added
  target alias + injected refs that resolve to the same columns; behavior is plan-identical. The
  `.sqllogic` suite asserts behavior, and uq-1…uq-22 plus the LEFT/RIGHT non-preserved-update tests
  pass untouched — but no one diffed the emitted plans/programs for a non-colliding multi-source
  UPDATE to confirm the alias is a true no-op at the plan level. The full-suite green is the evidence.
- **RETURNING through a multi-source view** rides `buildCapturedKeyPredicate` (left bare/untouched);
  no RETURNING regression observed, and deeper RETURNING-subquery correlation qualification remains
  out of scope (consistent with the plan).
- **No store-mode run.** Only memory-backed `yarn test` was run (the agent default); `yarn test:store`
  was not exercised. This change is pure planner AST lowering with no store-specific code path, so a
  store divergence is unlikely, but it was not verified.
- **Self-join / both-sides-update interactions** are covered only transitively by the existing suite
  (the new uq-23/24/25 are single-owning-side inner joins). The plan argues each side is an
  independent per-side UPDATE aliased `__vm_self` in isolation; a reviewer wanting belt-and-suspenders
  could add a self-join or both-sides `set a.x=…, b.y=…` case whose value subquery FROM collides with
  an owning PK.
