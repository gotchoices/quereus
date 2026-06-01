description: Live per-write lens constraint enforcement. The implement pass delivered the row-local CHECK enforcement class end-to-end (a logical `check` classified `enforced-row-local` fires on every insert/update through the lens, rewritten logical→basis and merged into the basis write's per-row check pipeline) plus the `lens.boundary.attached` marker. Set-level, FK, and optimizer FD-contribution classes were scoped out and are now tracked as plan-stage follow-ups. Reviewed, edge-case-hardened, docs reconciled.
prereq: lens-prover-and-attachment
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-prover.ts
----

## Summary

Second half of the lens layer: turning the prover's *classified*
`ConstraintObligation`s into *live* per-write enforcement. The implement stage
shipped **one class fully and honestly** — `enforced-row-local` CHECK — and
deferred the rest rather than ship four half-wired subsystems. The review
confirmed the delivered slice is correct, hardened it with edge-case regression
tests, reconciled stale doc-comments, and spawned `plan/` tickets for the four
deferred classes.

### What shipped (verified)

A logical `check` over reconstructible columns now fires on every insert/update
through a lens-backed logical table, even when the basis carries no such check:
- `planner/mutation/lens-enforcement.ts` (new) — `collectLensRowLocalConstraints`
  reads `slot.obligations`, keeps `enforced-row-local` CHECKs, rewrites each
  logical→basis via the slot's reconstructible projection, tags it
  `quereus.lens.boundary.attached`.
- `planner/building/view-mutation-builder.ts` — resolves the lens slot (only a
  logical schema has one ⇒ plain views/MVs unaffected), collects the constraints
  (skipped for DELETE), threads them into each base op.
- `constraint-builder.ts` / `insert.ts` / `update.ts` — the generic
  `additionalConstraints`/`extraConstraints` seam merges them into the existing
  per-row `ConstraintCheckNode`, reusing determinism validation, conflict
  resolution, OLD/NEW scope verbatim.

## Review findings

### Checked — correctness of the row-local slice

- **Logical→basis rewrite (the load-bearing, error-prone part).** Traced
  `logicalToBasisColumnMap` against the prover's `mappedBasisColumn` /
  `isReconstructibleColumn`: both walk `columnProvenance` (skipping hidden) in
  lockstep with `compiledBody.columns`, so the index alignment is identical to
  the prover's. The rewrite drops qualifiers for both mapped and unmapped columns,
  resolving against the single basis source — consistent with `single-source.ts`'s
  `normalizeBaseRefs`. **No defect.**
- **Aliasing / column-swap.** Added a regression test for a column-swapping
  override (`a←q, b←p`, check `a > b`): `transformExpr` substitutes each column
  once without re-substitution, so the swap rewrites correctly to `q > p`. **Correct.**
- **Multi-column renamed check** (`a <= b` over `lo`/`hi`): added a regression
  test; rewrites both columns to basis terms and enforces. **Correct.**
- **Operation flags / DELETE.** Synthetic constraint carries INSERT|UPDATE and is
  routed only to non-delete base ops; DELETE correctly enforces nothing. Verified
  by the implementer's test + re-read of `shouldCheckConstraint`. **Correct.**
- **No-overhead path.** A check-free / non-lens write resolves no slot ⇒ routes
  `[]`; verified the lookup short-circuits for plain views/MVs. **Correct.**

### Checked — conflict resolution interaction (new regression tests added)

- **`OR IGNORE`** on a lens row-local violation: the row is silently skipped (no
  throw, not inserted) — the synthetic constraint inherits statement-level conflict
  handling via the basis `ConstraintCheckNode`. Added a regression test asserting
  both the skip and that a satisfying row in the same statement shape still lands.
- **`OR REPLACE`** on a lens row-local violation: still aborts (REPLACE resolves
  uniqueness/NOT NULL, not CHECK — standard SQLite semantics). Added a regression
  test asserting the abort and zero rows.

### Checked — the NOT NULL "gap" (handoff gap #5) — investigated, NOT a defect

The handoff flagged a possible residual hole: a logical NOT-NULL column over a
nullable basis column accepting an explicit-NULL write through the lens. **Probed
three concrete shapes** (basis-default, logical-default, genuinely-nullable basis):
in every case the explicit-NULL write was **rejected** ("NOT NULL constraint
failed"). Root cause: Quereus's basis write path rejects an explicit NULL literal
into a typed column regardless of nominal nullability (confirmed even for a plain
`create table z (val integer)`), so the logical NOT NULL is transitively enforced
by the basis write, and the only unsound deploy shape (not-null logical over a
nullable basis with no default) is blocked at deploy by the prover's
`checkTypeAndNullability`. **No reachable hole — no ticket filed.** (Whether
Quereus *should* permit explicit NULL into a nominally-nullable column is a
separate engine question, out of scope for the lens layer.)

### Fixed inline (minor)

- **Stale doc-comments** pointing to the retired `planner/building/view-mutation.ts`
  (deleted when the view-mutation path was refactored into the propagate
  substrate). Repointed the lens read-only raise-site references to
  `planner/mutation/single-source.ts` `analyzeView` in `schema/lens.ts` and
  `schema/lens-prover.ts`, and refreshed the `obligations` JSDoc in `lens.ts` to
  state row-local is shipped / set-level + FK pending.
- **Edge-case regression tests** added to `test/lens-enforcement.spec.ts`
  (multi-column rename, column swap, `OR IGNORE`, `OR REPLACE`) — 5 → 9 tests.

### Major — deferred enforcement classes (spawned `plan/` tickets)

These were intentional scope cuts in the implement pass (each a distinct
subsystem). Filed as plan-stage tickets with the handoff's design notes carried
forward:
- `lens-set-level-commit-time-enforcement` — O(n) detection-only commit-time scan
  for an `enforced-set-level{commit-time}` key (synthetic-assertion lifecycle is
  the bulk of the work).
- `lens-set-level-rowtime-enforcement` (prereq: the commit-time ticket) — route
  the existence lookup through the basis covering structure; unlocks
  `insert or replace`/`or ignore`/`abort` through the lens.
- `lens-fk-enforcement-wiring` — commit-time cross-relation existence for an
  `enforced-fk`, with a redundancy decision vs a basis-carried FK.
- `lens-routed-constraint-fd-contribution` — surface a proved/enforced *declared*
  logical key as an FD to the optimizer (the "pending half" `docs/optimizer.md`
  notes).

### Not checked / out of band

- `yarn test:store` (LevelDB path) — not run per agent rules; the change is in the
  planner/builder layer and is storage-agnostic. A store-path sanity check on lens
  row-local enforcement remains a reasonable out-of-band ask.
- Multi-source put fan-out interaction — write-rejected upstream today; the
  `extraConstraints` single-base-op routing assumption was re-verified to hold.

## Build / test status

- `tsc --noEmit` (quereus): clean.
- `eslint` on all changed/new files: clean.
- Full quereus spec suite (`node test-runner.mjs`): **0 failures** (4145 passing,
  9 pending), including the 9 lens-enforcement tests (5 original + 4 added) and the
  unchanged 22 lens-prover/enforcement classification tests.
- No `.pre-existing-error.md` filed — no pre-existing failures surfaced.
