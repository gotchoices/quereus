description: COMPLETE — multi-source per-side UPDATE collision-proof correlation alias (`__vm_self`). The cross-source capture read-back owning-PK operands and the owning-side strip-to-bare refs are now qualified with the lowered per-side UPDATE's `SELF_ALIAS`, so a correlation reference emitted inside a user value subquery binds the lowered target row instead of re-binding to a same-named column in the subquery's own FROM. Reviewed, validated, and minor doc/comment drift fixed inline.
files:
  - packages/quereus/src/planner/mutation/single-source.ts       # SELF_ALIAS exported; docstring notes multi-source reuse
  - packages/quereus/src/planner/mutation/multi-source.ts        # capturedValueSubquery correlationAlias param; routePartnerRead, owning-strip, np read-back, per-side UPDATE alias; review fixed 3 stale docstrings
  - packages/quereus/src/planner/building/update.ts              # (unchanged) consumes stmt.alias as the AliasedScope correlation name
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-23 (bug 1), uq-24 (bug 2), uq-25 (composite-PK); review corrected uq-23's failure-mode comment
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` — __vm_self qualification
----

# Multi-source value-subquery correlation refs: `__vm_self` collision-proof alias

## What was built (implement stage)

The multi-source SET-value lowering emitted two kinds of **bare** (unqualified) owning-side
column references intended to correlate out to the lowered per-side UPDATE's target row, but
which rebind to a same-named column when nested inside a user value subquery whose FROM
introduces that name (innermost-scope SQL rules). Both are now qualified with the lowered
statement's synthesised collision-proof alias `SELF_ALIAS = '__vm_self'`, exactly as the
single-source spine already did:

1. **Capture read-back owning-PK operands** (`capturedValueSubquery`, bug 1) — gained a trailing
   optional `correlationAlias?: string`; when supplied each PK right operand becomes
   `{ type: 'column', name: pk, table: correlationAlias }` (every composite conjunct qualifies).
   Omitted ⇒ bare ⇒ byte-identical for `decomposition.ts` and any legacy caller.
2. **Owning-side strip** (`stripSideQualifier`'s `substitute`, bug 2) — the owning branch now
   returns `{ type: 'column', name: col.name, table: SELF_ALIAS }` instead of a bare column.
3. **Per-side UPDATE carries `alias: SELF_ALIAS`** so the base builder
   (`building/update.ts:136`) registers `__vm_self` as the target's `AliasedScope` correlation
   name that the qualified refs bind through.

`SELF_ALIAS` was promoted from a module-local const in `single-source.ts` to an export. The
multi-source per-side callers (`routePartnerRead`, the np matched read-back at
`multi-source.ts:~1513`) pass `SELF_ALIAS`. `buildCapturedKeyPredicate`, the existence-DELETE,
and the null-extended materialize INSERT were deliberately left untouched (per the plan).

## Review findings

**What was checked:** the full implement-stage diff (8eb5104a) read first with fresh eyes;
`AliasedScope` resolution semantics (the load-bearing correctness question); parity with the
single-source spine; the three new tests; every docstring the change touches *and* the ones it
should have; lint, typecheck, full memory-backed test suite; independent neuter-and-reproduce of
both fixes.

**Correctness — verified sound, no findings.**
- The `alias: SELF_ALIAS` mechanism mirrors single-source exactly (`single-source.ts:1133,1164`);
  multi-source per-side ops are flat single-table base UPDATEs re-planned through the same
  `building/update.ts`, so `__vm_self` is registered as the target's correlation name identically.
- **No table-name-qualification regression** (the one place this could silently break): with
  `alias = '__vm_self'`, `AliasedScope` only special-cases the `__vm_self.col` form; a
  *table-name*-qualified ref no longer resolves via the alias branch. Confirmed this is harmless —
  every ref reaching the per-side UPDATE statement against the target is either a **bare** PK ref
  (`buildCapturedKeyPredicate`, resolves via the underlying column scope) or a **`__vm_self`**-
  qualified ref (resolves via the alias branch). The owning-strip converts *both* `owning.alias`
  and `owning.schema.name` qualifiers to `__vm_self`, so no owning-table-name-qualified ref ever
  reaches the statement. The 6077-passing suite (incl. uq-1…22 and LEFT/RIGHT non-preserved-update
  tests) corroborates plan-identity for non-colliding statements.

**Tests — genuinely discriminating; one minor comment fix.**
- Independently **neutered each fix in isolation** and re-ran 93.4: bug-1 neutered → uq-23 fails
  with `ConstraintError: NOT NULL constraint failed: uq23_c.cval`; bug-2 neutered → uq-24 fails
  `realval=9` vs expected `6` (the rebind to `uq24_t.realval=999` → max(x<999)=9). Both restored.
- **Fixed inline:** uq-23's comment predicted a silent NULL read-back; the *observed* unfixed
  surface is the loud `NOT NULL constraint failed` above (the implementer flagged this discrepancy
  and I confirmed it). Comment corrected to name the actual surface.
- **Coverage gaps (acknowledged, not blocking):** self-join / both-sides `set a.x=…, b.y=…` with a
  colliding value-subquery FROM are covered only transitively (the plan's per-side-independence
  argument is sound — each side is an independently planned `__vm_self`-aliased flat UPDATE). The
  np-matched-read-back `SELF_ALIAS` addition (`multi-source.ts:1513`) is not exercised in the
  *nested-subquery* case, but is behavior-identical to bare for the non-nested case the existing
  outer-join tests cover. Neither rises to a new ticket.

**Docs — stale in-code docstrings found and fixed (minor).** The implementer updated
`view-updateability.md` and added clarifying comments at the two fix sites, but left several
`stripSideQualifier` / `capturedValueSubquery` docstrings still describing the **old** "strips to
bare" / "unqualified `<pk_j>` bind to the target row" behavior, now contradicted by the code.
Fixed three inline: (a) the `substitute` inline summary ("an owning-alias ref strips to bare" →
"is re-qualified to the lowered target's `__vm_self` alias", which directly contradicted the code
two lines below); (b) the cross-source-rewrite docstring example + prose (`= <pk0>` → `=
__vm_self.<pk0>`); (c) the `stripSideQualifier` opening sentence. The `capturedValueSubquery` base
docstring's "unqualified `<pk_j>`" wording is correct as-is — it describes the no-arg
(decomposition) default, with the `correlationAlias` addendum covering the qualified case.

**Lint / typecheck / tests — all pass.** `yarn workspace @quereus/quereus lint` clean;
`typecheck` (`tsc --noEmit`) clean; full memory-backed suite **6077 passing, 0 failing, 9 pending**
(before doc-only edits — re-confirmed lint+typecheck clean and the 93.4 file green after the
comment-only edits). No `.pre-existing-error.md` written (no failures surfaced).

**Not run (deferred, low risk):** `yarn test:store` was not exercised — this is pure planner AST
lowering with no store-specific code path, so a store divergence is implausible; left to CI /
out-of-band per the agent-runnable-time guidance.

## Disposition

No major findings → no new fix/plan/backlog tickets filed. Two minor findings fixed inline (test
comment accuracy + three stale source docstrings). Implementation is correct, tested, and
documented.
