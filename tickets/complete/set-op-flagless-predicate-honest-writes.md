description: Flag-less predicate-honest set-op writes — a flag-less `union [all]` of literal-discriminator legs (`'red' as kind`) made writable for INSERT (routed to consistent legs), DELETE / data-UPDATE (fanned to consistent legs), with literal discriminators read-only; binary `intersect` / `except` likewise. Reuses the membership substrate (capture + recursive `propagate` + fan helpers) via a shared `buildSetOpMutation` core; the per-leg branch oracle is the leg's σ-forwarded + literal-discriminator bindings classified by `checkSatisfiability`. Coexists with the shipped `exists`-membership path. Reviewed and completed.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md, docs/sql.md
----

## What shipped

A flag-less set-op view body of regular projected columns (plain base columns + literal
**discriminators**) is now writable — the *preferred* surface over the `exists`-membership path
(which is untouched; the two coexist, sharing the capture + per-branch `propagate` + fan
substrate via a shared `buildSetOpMutation(ctx, view, req, writeFn)` core).

- **Recognizer** `isSetOpFlaglessWritableBody` / `flaglessShape` (pure AST peek): a flag-less,
  non-`diff` body, no outer LIMIT/OFFSET, all legs plain-column / literal projections, in one of
  two shapes — a **union-like chain** (any depth → N flat legs) carrying ≥1 literal discriminator,
  or a **binary** `intersect` / `except` (2 legs). Mutually exclusive with the membership recognizer.
- **Dispatch** (`view-mutation-builder.ts`): the flag-less branch is gated to real views/MVs
  (`!view.ephemeral`).
- **Oracle** (Option B): each leg planned once; the per-leg oracle feeds `checkSatisfiability`
  the leg's planned physical `constantBindings`/`domainConstraints` + synthesized literal-
  discriminator `ConstantBinding`s + the mutation predicate. `unsat ⇒ skip`, `sat`/`unknown ⇒ include`.
- **Routing:** INSERT → consistent legs (`union`) / every leg (`intersect`) / left operand
  (`except`). DELETE / data-UPDATE → fan to consistent legs / left operand. Discriminator writes
  rejected `no-inverse`; RETURNING + SELECT-source insert rejected.
- **Static surfaces** (`schema.ts`): `view_info` YES/YES/YES; `column_info` plain columns YES,
  literal discriminators NO — gated on the same recognizer as the dynamic write.

See docs/view-updateability.md § Set Operations and docs/sql.md.

## Review findings

**Verdict: implementation is sound and ships as the preferred surface. Tests + lint green
(6273 passing, 0 failing; lint clean). Two follow-up tickets filed; minor test/doc gaps fixed
inline.**

### Checked — and what was found

- **Read the full implement diff first** (set-op.ts +474, view-mutation-builder.ts,
  propagate.ts, schema.ts, 93.6, docs) with fresh eyes before the handoff. Then verified the
  reused substrate (`buildSetOpCapture`, `buildMemberExists`, `fanBranchDelete`,
  `fanBranchDataUpdate`, `SetOpAnalysis`/`SetOpBranch`, `findSetOpNode`) and the
  `checkSatisfiability` / `ConstantBinding` contract.
- **Oracle correctness (SPP / type safety).** The synthesized discriminator binding
  `{ attrs:[i], value:{ kind:'literal', value } }` exactly matches what sat-checker consumes
  (`b.value.kind==='literal'`, seeds the accumulator); `attrIndex` and the binding `attrs` both
  key on positional leg-output index — consistent. `null` discriminators correctly emit no
  binding (NULL-safe via `nullSafeEqual` in member-exists). The `as` casts
  (`ResultColumnExpr.expr`, `core as SelectStmt`, `root as RelationalPlanNode`) are all guarded
  by prior checks. No `any`. **No defects found here.**
- **Recognizer boundaries (verified by added tests).** Discriminator-less `union all` →
  conservative all-`NO` static AND dynamic reject; deep/mixed `intersect` chain → all-`NO`;
  `union` (DISTINCT) of discriminator legs → writable; mutual exclusion with the membership
  recognizer holds. **Agree — no over-claim on these boundaries.**
- **Member-exists over the full data tuple incl. literal discriminators** (handoff Finding #5,
  the novel `b.<literal-projection>` correlation): exercised by U6/U7 in 93.6 (the leg's literal
  resolves to a constant in the `k.<col> = leg.<col>` self-restriction). **Works as designed.**
- **Routing / fan-out** (INSERT to consistent legs, DELETE/UPDATE fan, `intersect` every-leg,
  `except` left-only, discriminator `no-inverse`, unknown-column reject): all green in 93.6 and
  re-traced by hand against the base-table effects. **Correct.**
- **Docs.** docs/sql.md and docs/view-updateability.md read end-to-end against the new reality —
  accurate. Added the two missing limitation notes (below).

### Found and FIXED inline (minor)

- **Static-surface reject-side gap** (the implementer-flagged "goldens row worth adding"):
  93.6 asserted only the writable side. Added reject-boundary assertions — discriminator-less
  `union all` (static all-`NO` + `column_info` all-`NO` + dynamic insert reject), deep
  `intersect` (static all-`NO`) — plus `union` (DISTINCT) write coverage and the partial-
  discriminator-omission case (clean PK conflict, not corruption). All pass.
- **Doc gaps:** documented (a) partial-discriminator-omission → multi-leg routing → clean PK
  conflict, and (b) the range-σ INSERT over-inclusion and join-leg internal-error limitations
  with their follow-up ticket slugs, in docs/view-updateability.md § Set Operations.

### Found and FILED as follow-ups (major)

- **`tickets/fix/set-op-write-multisource-leg-capture.md`** — a set-op view whose branch/leg is
  a JOIN body fails at runtime with the internal error `k.k0_0 isn't a column` (nested
  multi-source capture collides with the outer set-op capture's `__vmupd_keys`), and the static
  surfaces over-claim `YES`. **This is a PRE-EXISTING shared-substrate limitation** — the shipped
  `exists`-membership path exhibits the identical failure for a join branch (verified with a
  direct repro); the flag-less recognizer merely makes it newly reachable. Both paths' column-only
  shape gates admit a join leg they cannot actually write. Ticket gives two resolution options
  (clean reject vs compose the nested capture) and requires static/dynamic agreement either way.
- **`tickets/backlog/set-op-flagless-range-sigma-oracle.md`** — handoff Finding #1: a leg
  discriminating by a non-`=` (range) σ on a *projected* column is invisible to the oracle, so an
  INSERT can land a phantom base row. DELETE/UPDATE self-correct via member-exists; INSERT does
  not. Documented v1 limitation, not a regression; ticket proposes feeding remapped range-σ
  conjuncts (or an output `DomainConstraint`) into the oracle.

### Explicitly empty / accepted-as-is

- **Resource cleanup / runtime substrate:** none introduced (plan-time decomposition only; rides
  the existing `ViewMutationNode.identityCapture` void/drain path). Nothing to review.
- **Handoff Findings #2 (union needs ≥1 discriminator), #3 (ephemeral/CTE gated out), #4
  (intersect/except binary only), #7 (bag/overlap):** confirmed as intentional, documented v1
  scoping decisions that preserve the established phase-1 rejects with no static/dynamic drift —
  accepted, no action.
- **Handoff Finding #8 (no dedicated `checkSatisfiability` unit test):** the checker is pinned by
  `predicate-contradiction.spec.ts`, and the leg-classification verdicts (`sat`/`unsat`/`unknown`)
  are now exercised end-to-end by the routing/fan/skip assertions in 93.6 (incl. the U6/U7 honest-
  unknown cases). Adequate for v1; a focused unit pin remains a nice-to-have, not filed.

### Validation

- `yarn workspace @quereus/quereus lint` → clean.
- `yarn workspace @quereus/quereus test` → 6273 passing, 0 failing, 9 pending (before and after
  the inline test/doc additions).
- Edge-case probes (join-leg, omitted-discriminator, union-distinct, reject boundaries) run
  against the engine directly; scratch files removed.
