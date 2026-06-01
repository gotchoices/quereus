description: Multi-source (inner-join) UPDATE that assigns BOTH base sides while the WHERE predicate filters on the FK-parent's reassigned column previously dropped the FK-child base mutation (the FK-parent op ran first, rewrote the predicate column, so the FK-child op's live identifying subquery matched nothing and silently no-op'd). Fixed by capturing each affected view row's base-PK identities `(k0, k1)` ONCE up-front (before any base op mutates) and routing BOTH per-side base ops' identifying `in`-subqueries through that captured set (`<pk> in (select k<side> from __vmupd_keys)`) — a mutation-order-independent identity. Generalizes the per-row identity-capture plumbing the multi-source UPDATE RETURNING path already shipped, so a both-sides update *with* RETURNING materializes the capture exactly once (shared between base ops and the re-query). Reviewed and completed.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Summary

The fix routes both per-side base ops of a both-sides multi-source UPDATE through a
single up-front identity capture instead of a live re-query of the join body:

- **`multi-source.ts`** — `decomposeUpdate` computes `bothSidesAssigned`; when true,
  each side's identifying `in`-subquery becomes `select k<side> from __vmupd_keys`
  (`buildCapturedKeySubquery`) rather than the live join-body subquery. Single-side
  keeps the live subquery (no ordering hazard). Factored
  `buildMultiSourceUpdateKeyCapture` + `makeMultiSourceUpdateKeyRef` out of the old
  RETURNING builder; `buildMultiSourceUpdateReturning` now accepts the pre-built
  capture. CTE renamed `__vmret_keys` → `__vmupd_keys`.
- **`view-mutation-builder.ts`** — `buildUpdateIdentityCapture` builds the capture
  once when a multi-source update assigns both sides OR carries RETURNING;
  `withKeyCapture` injects a fresh `__vmupd_keys` key ref per base op (gated on
  `baseOps.length > 1`). The same capture feeds `ViewMutationNode` and the RETURNING
  re-query, so a both-sides update with RETURNING captures exactly once.
- **`view-mutation-node.ts`** — `ReturningCapture`→`IdentityCapture`,
  `returningCapture`→`identityCapture`; materialized for base ops too, not just
  RETURNING. Capture source stays excluded from `getRelations` (side input), so a
  both-sides void update remains a void node.
- **`view-mutation.ts`** — hoisted capture materialization into a `runBody` wrapper
  so the void both-sides update also materializes `__vmupd_keys` before
  `drainBaseOps`.
- **Docs** — `docs/view-updateability.md` §§ Inner Join, Multi-Base-Table Mutations,
  `returning` Clauses updated; the closed bug dropped from the deferred list.

## Review findings

**Scope reviewed:** the full implement diff (commit `42b62911`) read first with fresh
eyes, then the handoff summary; every touched file read in full plus the surrounding
resolution machinery (`select-context.ts`, `select.ts`/`buildFrom` CTE resolution,
`propagate.ts` path selection, `expression.ts` subquery CTE threading).

### Correctness — no defects found
- **Gating consistency.** Verified `bothSidesAssigned` (in `decomposeUpdate`, =
  `perSide[0].length>0 && perSide[1].length>0`) is equivalent to `baseOps.length > 1`
  (the loop emits one op per non-empty side), so the decomposer's choice to emit
  `select k<side> from __vmupd_keys` and the builder's `injectKeyRef = !!keyCapture &&
  baseOps.length > 1` can never diverge — the captured-key subquery always has its
  `__vmupd_keys` cteNode injected. They reference the same view, so they agree.
- **k0/k1 ↔ sideIndex mapping.** `buildCapturedKeySubquery(sideIndex)` reads
  `k<sideIndex>` indexed off `analysis.sides`; the capture SELECT aliases
  `sides[0].pk → k0`, `sides[1].pk → k1`. Consistent.
- **CTE resolution path.** `withKeyCapture` sets `ctx.cteNodes[__vmupd_keys]`; a base
  op's `in`-subquery (no enclosing WITH) resolves via `select-context.ts:20`
  (`parentCTEs.size>0 ? parentCTEs : ctx.cteNodes`) → `ctx.cteNodes` → the injected
  ref. The RETURNING re-query passes `__vmupd_keys` explicitly as `parentCTEs`. Both
  resolve.
- **Path exclusivity.** `decompositionStorage` short-circuits in `propagate` before
  `isJoinBody`/`propagateMultiSource`, so `decomposeUpdate` (and its captured-key
  subqueries) never runs for a decomposition-backed table — matching
  `buildUpdateIdentityCapture`'s `!decompositionStorage` guard.
- **Shared descriptor stitch.** Up to three `InternalRecursiveCTERefNode`s (2 base
  ops + RETURNING re-query) share one `{}` descriptor with fresh attr ids each; the
  emitter materializes the rows under that descriptor in `rctx.tableContexts`.
  `withChildren` preserves the descriptor by identity across optimizer rewrites, so
  the runtime stitch survives. Param ordering in the emitter
  (`baseOps, returning, capture.source, envelope`) matches `getChildren`/`withChildren`.
- **Void path.** `descriptor` in the emitter is the *envelope* descriptor; a
  both-sides void update has no envelope → falls to the void branch, with
  `__vmupd_keys` already materialized by `run`'s wrapper. Correct.
- **Duplicate-key safety.** A parent shared by multiple captured children yields a
  duplicate k1 in the capture; `<pk> in (...)` is set-semantic so the parent updates
  once. Confirmed by the repro (children 1,2 → parent 10).

### Edge cases / tests
- **MINOR (fixed inline):** the implementer flagged a missing test combining a
  both-sides predicate clash with a view **body `WHERE`**. Added `bw_*` tables / view
  `bw_jv` (`… where c.active = 1`) to `93.4-view-mutation.sqllogic`: a both-sides
  update predicated on the FK-parent's reassigned `label`, where a hidden child
  (`active=0`) shares the parent row of a visible one. Confirms (a) the capture's
  `idPredicate` = user WHERE ∧ body WHERE applies to the pre-mutation image, and (b)
  the capture pins per-CHILD-PK, so the hidden child's `note` is untouched even though
  the FK-parent op rewrites the shared parent's `label`. Passes.
- Verified the implementer's reframed RETURNING (d) cases (parent-predicate clash now
  asserts both sides land; child-predicate clash; single-side `returning *`) and the
  new non-RETURNING `pc_*` twin all pass.

### Renames / dead references
- `find_references` confirms zero remaining `returningCapture` / `ReturningCapture` /
  `__vmret_keys` anywhere in the tree. Clean rename.

### Docs
- Read every changed doc section. `docs/view-updateability.md` accurately describes the
  up-front capture for both base ops + RETURNING, the `__vmupd_keys`/`identityCapture`
  renames, the single-shared-capture note, and drops the closed bug from the deferred
  list. The single remaining mention of the slug is the accurate "now-closed" note.

### Reviewer-flagged gaps NOT actioned (deliberately, with reasons)
- **strict-fork mode (`QUEREUS_FORK_STRICT`) not exercised.** The capture set/delete
  wraps the whole `run` (mirroring the prior RETURNING-update and insert-envelope
  patterns, both already shipped under the same lifecycle), so this is not a new
  hazard class — it is the established context-side-input pattern. Not worth a ticket;
  a strict-fork CI sweep, if desired, belongs to the broader fork-test harness, not
  this fix.
- **Optimizer node-identity cross-talk** (implementer's first focus item). Each base
  op gets a freshly-minted key ref (distinct attr ids); only the descriptor is shared,
  which is the intended runtime stitch and identical to the already-shipped
  RETURNING-capture pattern. `emit-roundtrip-property` and all both-sides cases pass.
  No coupling found.
- **Shared-parent fanout semantics** (a both-sides update rewriting a parent column
  affects *all* view rows of that parent, including ones outside the predicate via the
  shared base row). This is inherent to base-decomposition and pre-existing (the
  live-subquery path behaved identically); it is not a regression of this change. The
  `bw_jv` test documents the per-child-PK scoping that bounds it. Out of scope.
- **Base-PK / join-key / FK rewrite breaking the captured identity**, and the general
  n-base snapshot-consistent multi-side DELETE fan-out — both remain documented as out
  of scope in `docs/view-updateability.md`; untouched here.

### Validation (all green)
- `yarn build` — clean.
- Full `packages/quereus` suite (`yarn test`): **4260 passing, 9 pending, 0 failing**
  (run before the test addition).
- `93.4-view-mutation` targeted (`--grep`): **1 passing** (after the `bw_*` addition;
  the only file changed in this pass, so the rest of the suite is unaffected).
- `yarn lint` (quereus): exit 0.

No major findings; no follow-up tickets filed.
