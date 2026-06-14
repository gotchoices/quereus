description: Multi-source (INNER join) leg compose for set-op view writes. A join branch's UPDATE / data-UPDATE / DELETE / membership-`=false` composes by building an inner per-branch base-PK capture (`__vmupd_keys$N`) chained off the outer set-op capture, so the join leg decomposes through the multi-source machinery without colliding with the outer capture. INSERT into a join leg and OUTER/cross legs are deferred (clean rejects). Reviewed, refined, and shipped.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
----

## What shipped

An **INNER-join leg** of a set-op view body is now writable for UPDATE / data-UPDATE / DELETE /
membership `=false`, on both the `exists`-membership path and the flag-less predicate-honest path.
The join branch is composed (rather than routed through plain `propagate`) by building an inner
per-branch base-PK capture under a fresh `__vmupd_keys$N` name, chained off the outer set-op capture
(filtered by the same `buildMemberExists` predicate), and bubbled up on
`SetOpWritePlan.nestedCaptures` → `ViewMutationNode.nestedCaptures` (materialized outer-first, then
each inner, before the base ops; torn down in reverse). INSERT into a join leg and OUTER/cross legs
are deferred as clean rejects with matching all-`NO` / `is_insertable_into = NO` static surfaces.

See the implement-stage handoff (commit `938b1c94`) for the full mechanism writeup. This file
records the review pass.

## Review findings

### Verified correct (read + re-derived)

- **The capture-chaining mechanism.** Traced `fanMultiSourceBranch` → `analyzeJoinView` +
  `decomposeUpdate`/`decomposeDelete` (referencing the fresh `__vmupd_keys$N`) + `buildMultiSourceKeyCapture`
  (over the branch join body, under a ctx with the OUTER capture injected via `withKeyCapture`). The
  inner capture's filter IS `branchStmt.where` = the `buildMemberExists` predicate, which references
  the outer `__vmupd_keys` (alias `k`) and the synthetic branch-view name. `substituteViewColumns`
  rewrites the branch-view-qualified refs to base terms while leaving the `k.*` outer refs untouched
  (qualifier `'k'` ≠ view name ⇒ pass-through). Correct by construction and confirmed by all scenarios.
- **The ordered-capture substrate** (`ViewMutationNode.nestedCaptures` + `emitViewMutation`):
  materialize primary → nested[0] → … in order, tear down in reverse in `finally`. Halloween-safe
  (HV test) and order-independent across a branch's own base ops.
- **Distinct inner-capture names** (`__vmupd_keys$1`/`$2`): the monotonic `mintName` counter never
  resets between branches (TWO test, UPDATE).
- **RETURNING through a join-leg set-op write rejects cleanly** — `rejectReturning` is called in
  every set-op write builder and is unchanged. Probe confirmed (`update … returning x` → clean error).
- **Lint** (`yarn workspace @quereus/quereus lint`, eslint + `tsc -p tsconfig.test.json`) → exit 0.
  **Main tsc** (`tsc -p tsconfig.json --noEmit`) → exit 0. **Full suite** (`yarn … test`, memory
  mode) → **6314 passing, 9 pending, 0 failing**.

### Findings fixed in this pass (minor)

- **DRY: duplicated `capturedSideIndices`.** The helper was copy-pasted in both
  `view-mutation-builder.ts` and `set-op.ts` (the latter with a comment claiming an import would
  cycle). It does not — both modules import `multi-source.ts`, which now **exports** the single copy;
  both call sites import it from there. (The cycle the comment feared was set-op ↔ view-mutation-builder,
  not via multi-source.) Net −1 duplicate, no behavior change; full suite still green.
- **Doc/comment inaccuracy re: non-equi inner joins.** The ticket prose, the docs, and three code
  comments/one diagnostic message claimed an "OUTER / cross / **non-equi**" join leg is "deferred,
  rejected at branch classification". This is **false for the membership path**: `isInnerJoinBody`
  keys only on `joinType`, so a non-equi (theta) inner join is **admitted and composed** there —
  exactly as the standalone join-view path already admits it (probed: standalone non-equi join view
  reports `YES/YES/YES`; membership non-equi branch composes and runs without error or corruption).
  Only the flag-less path conservatively defers non-equi (all-`NO`). Corrected the membership-path
  comment in `isOperandWritable`, the `buildBranch` comment + its diagnostic message (now says
  "OUTER (left/right/full) or cross join leg"), and `docs/view-updateability.md` § Set Operations to
  describe the actual split honestly.

### Findings filed (major → new ticket)

- **`tickets/backlog/set-op-write-multisource-leg-nonequi.md`** — the non-equi inner-join handling is
  **inconsistent across the two set-op paths** (membership composes it, consistent with standalone;
  flag-less defers it). Both behaviors are safe (no data corruption), so this is a behavioral/scope
  inconsistency, not a correctness bug — but it should be unified (accept-everywhere or
  reject-everywhere, a design decision). Filed for a deliberate choice rather than papered over.

### Tests added (coverage gaps the implementer flagged)

- **Two-join-branch DELETE** (`93.4`, TWO view): a single `delete from TWO where id=2` exercises
  BOTH inner captures (`$1`/`$2`) materializing and tearing down — the implementer tested only the
  two-branch UPDATE; this confirms the ordered-capture substrate for DELETE.
- **Non-equi (theta) inner-join leg deferral on the flag-less path** (`93.6`, NEV view): locks in the
  safe all-`NO` + clean-reject behavior (static and dynamic), guarding against a future change that
  would silently start composing it on the flag-less path.

### Findings checked — empty, with reason

- **Data corruption / wrong base rows.** None found. All five composed scenarios (MV, JV, DV, CV,
  SJ) plus the new TWO-DELETE mutate exactly the intended base rows; the non-equi cartesian-duplicate
  case dedupes harmlessly through the PK-keyed base op (verified by probe).
- **Resource/context leaks.** None: the emitter's `finally` tears down every materialized capture in
  reverse order, including on a mid-statement throw (read in `emit/view-mutation.ts`).
- **Type safety.** No `any` introduced; both tsc passes clean.

### Noted, not actioned (acceptable as-is)

- **DELETE through a join leg fans to BOTH inner-join sides** (lenient ambiguous-delete default,
  inherited from the multi-source spine). Documented, asserted, and consistent with the standalone
  path — intended set-op delete semantics.
- **column_info reports null base for join-leg columns** — matches the established
  "writable-through-effect" convention for all set-op view columns (a fan-out has no single owning
  base column). Deliberate; agreed.
- **`except`/`intersect` subtree with an INNER-join leaf** — the gate flags ARE threaded into the
  inner capture's `memberExists` filter (correct by construction; `fanMultiSourceBranch` reuses
  `branchStmt.where`, which carries the accumulated gate). Verified by reading; a dedicated test for
  this specific nested shape was not added (intricate to construct, mechanism already exercised by
  the gate-flag plumbing in the non-join nested tests). Low risk; left for a future pass.
- **Leg-local LIMIT/ORDER BY in a join leg** — not a concern: `select … limit N union all …` is not
  parseable in a bare union member (parser rejects it), so the modifier cannot leak into the inner
  capture for the union form.
