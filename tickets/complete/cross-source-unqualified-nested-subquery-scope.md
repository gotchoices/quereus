description: Side-alias-qualify bare base-term lineage leaves at view-column substitution time (the multi-source analog of single-source baseQualify), reverting stripSideQualifier to a purely qualifier-driven rule — so a partner column a join-view projects BARE rides the `__vmupd_keys` capture at ANY nesting depth instead of mis-routing or silently mis-binding inside a value subquery.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # makeSideQualifyScope (new), substituteViewColumns (sides param + sideQualify), stripSideQualifier (qualifier-only), 4 call sites
  - packages/quereus/src/planner/mutation/single-source.ts       # docstring-only updates
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-10..uq-16
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set`
----

# Complete: side-alias-qualify bare lineage leaves; strip is qualifier-only again

## What shipped

The SET-value / WHERE / RETURNING lowering for join views is two walks:
(1) the scope-aware view-column → base-term substitution (`substituteViewColumns`
over `makeViewColumnDescend`), then (2) the qualifier strip (`stripSideQualifier`).
Previously, a partner column the body projected **bare** injected a bare lineage
leaf that walk 2 resolved against the view sides — but only at the value's TOP
LEVEL, because resolving a bare name inside the scope-unaware strip descent is
unsound (it can't distinguish a lineage leaf from a user-authored inner-scope
name). A bare partner read nested in a value subquery therefore mis-routed or
silently mis-bound.

Now walk 1 **side-alias-qualifies bare lineage leaves at injection time**:

- New `makeSideQualifyScope(sides, view)` — a `ScopeContext` whose substitution
  qualifies a bare, non-shadowed leaf with its uniquely-owning side's **alias**
  (`resolveColumnSide`); a name on no side stays bare (lineage-internal
  correlated/local); a name on 2+ sides is structurally precluded (body planning
  rejects ambiguous bare projection). `unresolvableScope: 'reject'` +
  `rejectDmlSubquery`, mirroring single-source `makeBaseQualifyScope`.
- `substituteViewColumns` gained a `sides` param; `sideQualify` is applied to every
  replacement — top-level substitute AND as `makeViewColumnDescend`'s `baseQualify`.
  All four call sites thread `analysis.sides`.
- `stripSideQualifier` reverted to ONE qualifier-only substitute threaded uniformly
  (`substituteTop` and its bare-resolution branch deleted). A bare leaf reaching the
  strip is now only ever a user-authored local/unknown name — left untouched.
- Docstrings in both mutation files updated; docs § Inner Join cross-source `set`
  rewritten (the "top level only … must be projected qualified" restriction is gone).

## Review findings

Adversarial pass over commit `12308d46`. Scrutinised from correctness, scope
soundness, encapsulation, DRY, type-safety, dead-code, docs, and test-coverage
angles.

### Verified correct (no action)

- **Top-level behavioral equivalence with the deleted `substituteTop`.** Traced all
  three cases by hand: owning-side bare (`cval`→`c.cval`→strip to bare→lowered
  UPDATE) ≡ old (stayed bare); partner bare (`pv`→`p.pv`→capture) ≡ old
  (resolve-then-route); no-side bare (stays bare) ≡ old. The change is a strict
  superset: the *nested* case now works, top-level is unchanged. uq-1..uq-9 pass
  unchanged.
- **Idempotence / no double-qualify.** `makeSideQualifyScope.makeSubstitute` returns
  `undefined` for an already-qualified leaf; the descent qualifies a nested
  view-column ref exactly once (top-level substitute is mutually exclusive with the
  descent). The shared `viewColToBaseRef` entry is never mutated (`transformExpr`
  spreads + `cloneExpr`).
- **`NO_SHADOW` entry for the lineage walk is correct** — a lineage's correlation
  refs always bind to the join body, never to a user's intervening subquery scope,
  so entering the lineage walk un-shadowed is right; the lineage's own nested FROMs
  shadow its locals via the shared scoped descent.
- **Scope-context division of labour.** uq-12's `select *` reject comes from
  `makeViewScope`'s taint path ("cannot be proven correlated"), the single-source
  case-(f) analog; `makeSideQualifyScope`'s reject is for an unresolvable scope
  *inside the lineage itself* — distinct, both correct.
- **No dead code / unused imports.** `cloneExpr`, `substituteNewRefs`,
  `resolveColumnSide`, `allSides`/`owningSideIndex` in `stripSideQualifier` all
  still referenced. Lint clean.
- **Self-join + bare projection** is structurally precluded (identical column sets
  ⇒ any bare side column is on 2+ sides ⇒ rejected at body planning), so the
  no-side/2-side `undefined` branches handle it without a dedicated test.
- **Parked-hazard references are real**: `multi-source-capture-correlation-alias-collision`
  and `cross-source-strip-side-alias-shadowing` both exist in `tickets/backlog/`.
- **Docs** reflect the new mechanism; the `§ View columns nested inside a predicate
  / assigned-value subquery` cross-reference resolves (heading present at line 135).

### Minor — fixed inline this pass

- **Documented-but-untested "loud-over-silent" behavior change.** The ticket flagged
  that a lineage containing a `select *` / TVF subquery now **rejects** on
  substitution (`makeSideQualifyScope`, `unresolvableScope: 'reject'`) where it
  previously substituted unqualified — with *no test pinning it*. I reproduced it
  (a same-side computed column over a `select *` source, to keep the cross-source
  computed-read gate from firing first) and confirmed it raises the documented
  `unsupported-subquery-correlation` ("source columns are not statically
  resolvable") rather than silently mis-binding. **Added `uq-16`** pinning this.

### Major — filed as a follow-up ticket

- **Cross-source computed-column READ: top-level reject vs nested admit.** The
  implementer explicitly asked for confirmation here. `gateCrossSourceReads` walks
  only top-level refs (`forEachTopLevelColumnRef` — unchanged by this diff), so a
  computed partner column read **at top level** is rejected `no-inverse`, while the
  same read **nested in a value subquery** is admitted via per-leaf base capture
  (uq-11). I confirmed the nested admission is **value-safe** (every leaf captured
  pre-mutation, scalar applies on read; the `no-inverse` reject is only needed to
  *write* a computed column, not read it) — so this is an inconsistent *acceptance
  surface*, not a wrong-result bug. It pre-existed for qualified computed columns;
  the change merely made it reachable for bare projection. Filed
  `tickets/backlog/cross-source-computed-read-toplevel-nested-asymmetry.md` to
  unify the two depths (preferred direction: permit the read at top level too).

### Checked, not pinned with a new test (mechanism-identical)

- DELETE-WHERE and RETURNING nested bare-partner reads route through the *same*
  `substituteViewColumns(…, analysis.sides)` path that uq-10 (SET) and uq-15 (WHERE)
  exercise; no distinct code path, so no separate regression test was added.
- The "double walk" (sideQualify inside the top-level substitute, then
  `transformExpr`'s clone of the returned replacement) does one redundant clone per
  substitution — negligible, left as-is.

## Validation

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — **5977 passing / 9 pending**, 0 failing.
- Targeted: `test:single … --grep "93.4"` green with uq-16 added.
- No pre-existing failures surfaced; no `.pre-existing-error.md` written.

## Follow-ups (backlog)

- `cross-source-computed-read-toplevel-nested-asymmetry` (filed this pass)
- `multi-source-capture-correlation-alias-collision` (pre-existing, parked by implement)
- `cross-source-strip-side-alias-shadowing` (pre-existing, parked by implement)
