description: Review the flag-less predicate-honest set-op write path — a flag-less `union [all]` of literal-discriminator legs (`'red' as kind`) made writable for INSERT (routed to consistent legs), DELETE / data-UPDATE (fanned to consistent legs), with literal discriminators read-only. Reuses the membership substrate (capture + recursive `propagate` + fan helpers) via a shared `buildSetOpMutation` core; the per-leg branch oracle is the leg's σ-forwarded + literal-discriminator bindings classified by `checkSatisfiability` (Option B — synthesized discriminator bindings, no physical-path change). Coexists with the shipped `exists`-membership path.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md, docs/sql.md
difficulty: hard
----

## What shipped

A flag-less set-op view body of **regular projected columns** (plain base columns + literal
**discriminators**) is now writable, the *preferred* surface over the `exists`-membership path
(which is untouched; the two coexist, sharing the capture + per-branch `propagate` + fan substrate).

- **Recognizer** `isSetOpFlaglessWritableBody` (`set-op.ts`): pure AST peek. Admits a flag-less,
  non-`diff` body with no outer LIMIT/OFFSET whose legs are all plain-column / literal projections,
  in one of two shapes: a **union-like chain** (`union` / `union all`, any depth → N flat legs) that
  carries **≥1 literal discriminator**, or a **binary** `intersect` / `except` (depth-1, 2 legs).
  Mutually exclusive with `isSetOpMembershipBody` (any `exists … as <flag>` anywhere ⇒ membership).
- **Dispatch** (`view-mutation-builder.ts`): `buildSetOpMutation` is now parameterized by a per-shape
  write builder — `buildSetOpWrite` (membership) or `buildFlaglessSetOpWrite` (flag-less). The
  flag-less branch is gated to **real views/MVs** (`!view.ephemeral`).
- **Oracle** (Option B): each leg is planned once; the oracle feeds `checkSatisfiability` the leg's
  planned physical `constantBindings`/`domainConstraints` (which forward a `=`-σ on a *projected*
  column, e.g. `where color='red'` → output column) **plus synthesized literal-discriminator
  `ConstantBinding`s read straight from the leg AST** (peeling Cast/Collate), with the mutation
  predicate (user WHERE, or per-row insert existence predicate) as conjuncts. `unsat ⇒ skip`,
  `sat`/`unknown ⇒ include`.
- **Routing:** INSERT → consistent legs (`union`); every leg (`intersect`); left operand (`except`).
  DELETE / data-UPDATE → fan to consistent legs (`union`/`intersect`); left operand (`except`).
  Discriminator writes (`set kind = …`) rejected `no-inverse`. RETURNING + SELECT-source insert rejected.
- **Static surfaces** (`schema.ts`): `view_info` reports YES/YES/YES for a recognized flag-less body;
  `column_info` reports plain data columns `is_updatable = YES`, literal discriminators `NO`. Gated on
  the same recognizer as the dynamic write, so static/dynamic cannot drift.

## Validation done (the floor, not the ceiling)

- `yarn workspace @quereus/quereus test` → **6273 passing, 0 failing** (memory vtab).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus run build` → clean.
- New `test/logic/93.6-set-op-flagless-write.sqllogic`: read + static surfaces; INSERT routing to the
  single consistent leg (others provably `unsat`) + omitted-base-column σ recovery; DELETE fan-out
  (`kind='large'` → both `size='large'` legs, `red` legs skipped); data-UPDATE fan-out (`src='A'` →
  both items_a legs); discriminator read-only (`set kind`/`set src` → error); unknown-column reject;
  SELECT-source + RETURNING rejects; provably-inconsistent skip; honest unknown-include via `like`
  (no false `unsat`, member-exists self-restricts the no-op leg); `intersect` (insert/delete fan to
  every leg); `except` (insert/delete the left operand only).

## Use cases for the reviewer to exercise

- The four edge-case families in the original ticket: literal-discriminator routing, omitted-column
  recovery, provably-inconsistent-skip vs unknown-include, DELETE/UPDATE fan-out.
- Static-surface agreement: confirm a *rejected* boundary body (deep intersect/except, `select *` leg,
  outer LIMIT, discriminator-less union) reports the conservative all-`NO` AND the dynamic write
  rejects — i.e. no over-claim. (93.6 covers the writable side; the reject-side static rows are NOT
  yet asserted — a gap worth a goldens row in 06.3.4 / 06.3.5.)
- Coexistence: a body with `exists … as <flag>` still takes the membership path (structurally
  guaranteed by mutual exclusion + the full green suite, but no *dedicated* coexistence test exists).

## Known gaps / deviations — treat as starting points, not finished

1. **σ is fed via the leg's *planned physical bindings*, not as raw conjuncts.** This captures a
   `=`-σ on a *projected* column (via the framework's forwarding) and the discriminators, which covers
   every test case. It does **not** feed the leg's raw σ as conjuncts, so a **non-`=` σ on a projected
   column** (`where x < 5`, a range) is invisible to the oracle → the leg is included on `sat` (honest
   over-inclusion: member-exists self-corrects a DELETE/UPDATE; an INSERT could over-insert). The
   original ticket's wording ("feed the leg σ conjuncts") would need a base→output attribute remap to
   realize; I judged the planned-physical approach cleaner and equivalently sound for the supported
   fragment. **Reviewer: confirm this is acceptable, or push range-σ into the oracle.**
2. **union/unionAll requires ≥1 literal discriminator** to be writable (a discriminator-less union
   like `t union all t2` stays on the existing phase-1 reject — pins `93.2-view-mutation-pending`).
   This is a scoping decision matching the ticket's "literal-discriminator legs" framing and avoids
   static/dynamic drift (no honest insert routing without a discriminator). The recognizer wording in
   the ticket ("plain columns OR literals") is looser; intersect/except legitimately need no
   discriminator (operator routes). **Reviewer: confirm the boundary.**
3. **CTE / inline (ephemeral) targets are gated OUT** (`!view.ephemeral`). A flag-less set-op CTE
   target keeps its existing reject. The `propagate.ts:256` guard was **NOT broadened** to flag-less
   (kept membership-only): broadening changed the established "not updateable in phase 1" diagnostic
   for ephemeral set-op targets (`93.4-view-mutation.sqllogic:3432`, `93.2`). The existing
   `classifyViewBody` reject already handles a recursively-reached flag-less body cleanly, so the
   guard TODO is intentionally only partially honored. **Reviewer: confirm.**
4. **intersect / except are binary only.** A deep/mixed `intersect`/`except` chain is not flattened
   (its right-leaning associativity — see docs/sql.md § set-op grouping — is deferred) and stays on
   the existing reject. Binary coverage is one scenario each.
5. **member-exists matches the full data tuple including the literal discriminators** — this is the
   first use of single-source resolution of `b.<literal-projection>` in a correlation (resolves to the
   constant). It works and is tested, but is a novel path worth a skeptical look (e.g. NULL discriminator,
   collation interplay).
6. **Partial-discriminator insert ambiguity:** a discriminated-union insert that omits some
   discriminators may be consistent with >1 leg → inserted into multiple base tables (bag rows). Not
   rejected. Documented as the routing-ambiguity caveat, not covered by a test.
7. **Bag/overlap v1 limitation** (a row resident in multiple legs) — documented; the frozen capture
   mitigates double-update but a `union all` duplicate-tuple delete/update still fans to all copies.
8. **No dedicated `checkSatisfiability` unit test** for a leg classification — relied on the existing
   `predicate-contradiction.spec.ts` (which pins the checker) + the sqllogic routing tests. A focused
   unit pinning a leg's `sat`/`unsat`/`unknown` verdict would harden against oracle regressions.

## Pointers

- Core: `set-op.ts` § "Flag-less predicate-honest set-op writes" (recognizer `flaglessShape`,
  `buildFlaglessSetOpWrite`, `buildFlaglessLeg`, `legConsistency`, the `fanLegsFor*` routers).
  Exported helpers `isSetOpFlaglessWritableBody` / `flaglessDiscriminatorColumnNames` feed `schema.ts`.
- Shared core: `buildSetOpMutation(ctx, view, req, writeFn)` in `view-mutation-builder.ts`.
- Reuses verbatim: `buildSetOpCapture`, `buildMemberExists`, `fanBranchDelete`, `fanBranchDataUpdate`,
  `findSetOpNode`, `propagate`, `MS_UPDATE_KEYS_CTE`.
