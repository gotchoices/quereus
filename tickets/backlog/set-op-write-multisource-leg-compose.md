description: Feature-unlock for set-op view writes whose branch/leg body is a multi-source (JOIN) body. Today such legs are cleanly rejected (`set-op-write-multisource-leg-reject`) because the recursive per-branch `propagate` builds an inner multi-source identity capture that collides with the outer set-op capture — both hard-code the single relation name `__vmupd_keys` (`MS_UPDATE_KEYS_CTE`), so the inner `k.k0_0` key ref resolves against the outer-injected relation and throws. To actually support a join-branch set-op write, give each nested capture a distinct relation name / scope so an inner multi-source capture never collides with the outer set-op capture.
prereq: set-op-write-multisource-leg-reject
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
----

## Background

This is **Option 2** from the original `set-op-write-multisource-leg-capture` fix ticket — the
larger resolution that unlocks the feature rather than rejecting it. The companion fix ticket
`set-op-write-multisource-leg-reject` already restores soundness (static `NO/NO/NO` + a clean
dynamic diagnostic) by gating join legs out of both set-op write recognizers. This backlog
ticket removes that gate and makes a join-branch set-op write actually compose.

## The collision to resolve

`MS_UPDATE_KEYS_CTE` (`'__vmupd_keys'`) is a single hard-coded relation name shared by:
- the OUTER set-op capture (`buildSetOpCapture` in `set-op.ts`), whose columns are the view
  output columns (`id`, `x`, `src`, …), injected into `cteNodes` for the per-branch fan; and
- the INNER multi-source capture the recursive `propagate` → `propagateMultiSource` builds for
  a join branch (`withKeyCapture` in `view-mutation-builder.ts`), whose columns are
  `k<side>_<j>`.

When a join branch's base op reads `select … from __vmupd_keys k where k.k0_0 = …`, the name
binds to whichever `__vmupd_keys` cteNode is in scope — the outer one — which has no `k0_0`
column. The capture relation name is the single point of collision.

## Expected behavior

A set-op view whose branch/leg body is a single explicit n-way equi-join (the shape
`isDecomposableJoinBody` accepts) should be writable through the same per-branch fan-out the
single-source legs use:
- INSERT routed to the consistent leg(s) (flag-less) / the flagged branch (membership);
- DELETE / data-UPDATE fanned to the consistent leg(s) / member branch(es);
- the static `view_info` / `column_info` surfaces report writable, MATCHING the dynamic truth
  (no over-claim, no internal error).

## Design sketch (for the planner)

Give each nested `propagate`-driven capture a **distinct** relation name / scope so an inner
multi-source capture does not collide with the outer set-op capture. Candidate approaches the
implementer should weigh:

- Parameterize the capture relation name (a per-depth / per-branch suffix, e.g.
  `__vmupd_keys`, `__vmupd_keys$1`, …) threaded from `set-op.ts` into the recursive
  `propagate` and through `withKeyCapture` / `makeMultiSourceKeyRef` /
  `buildCapturedKeyPredicate` / `buildMultiSourceKeyCapture`, so the inner capture and its
  readers agree on a fresh name that shadows nothing.
- Or scope the capture by descriptor identity rather than by a literal CTE name, so name reuse
  is harmless.

Either way: the inner join branch's `k.k<side>_<j>` refs must resolve to the inner capture,
and the outer fan's `k.<viewcol>` refs to the outer capture, in the same lowered statement.

## TODO (when promoted)

- Remove the join-leg reject gate added by `set-op-write-multisource-leg-reject` (the
  `isJoinBody` checks in `isWritableLeafLeg`, `isOperandWritable`, and `buildBranch`).
- Thread a distinct capture relation name / scope through the nested `propagate` path so the
  inner multi-source capture and the outer set-op capture never collide.
- Restore the static surfaces (`schema.ts`) to report a join-leg set-op body writable, matching
  the now-working dynamic write.
- Positive coverage in `93.6` (flag-less join leg) and `93.4` (membership join branch):
  delete / update / insert through a join-leg set-op view actually mutate the right base rows.
