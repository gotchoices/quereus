description: Unlock set-op view writes whose branch/leg body is a multi-source (JOIN) body. Today such legs are cleanly rejected (`set-op-write-multisource-leg-reject`). Remove that gate and compose the write: build an INNER per-branch base-PK capture (distinct relation name, chained off the OUTER set-op capture) so the join branch decomposes through the multi-source machinery without colliding with the outer set-op capture. Restore the static surfaces to report a join-leg set-op body writable, matching the now-working dynamic write.
prereq: set-op-multisource-capture-relation-name-param, view-mutation-ordered-multi-capture
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: hard
----

## Background

This is **Option 2** from the original `set-op-write-multisource-leg-capture` fix — the
feature unlock, not the reject. The reject companion (`set-op-write-multisource-leg-reject`,
landed) gates join legs out of BOTH set-op write recognizers (the `exists`-membership path and
the flag-less predicate-honest path), so a join-leg set-op body statically reports all-`NO` and
dynamically rejects with a clean `multi-source (join) leg` diagnostic. This ticket removes that
gate and makes a join-branch set-op write actually compose.

The two prerequisite tickets supply the substrate this ticket assembles:
- `set-op-multisource-capture-relation-name-param` — the multi-source capture machinery now
  takes a `captureRelationName` (the capture carries its own `relationName`), so an inner
  capture can use a fresh name that shadows nothing.
- `view-mutation-ordered-multi-capture` — `ViewMutationNode` + emit now carry an ORDERED list of
  captures, materialized outer-first then inner, with the inner's source free to scan the outer.

## The collision, and how composition resolves it

A set-op branch is itself a view body lowered through `propagate` against a synthetic
branch-view-like. A **single-source** branch lowers to one base op whose `where` is a
correlated `exists (… from __vmupd_keys k where k.<viewcol> = b.<branchcol> …)` against the
OUTER set-op capture (columns = view-output columns). That resolves fine.

A **join** branch routes (via `propagate`) to `propagateMultiSource`, whose emitted base-op
predicates reference the INNER multi-source capture's `k.k<side>_<j>` PK columns — but
`propagate`/`propagateMultiSource` **build no capture** (the capture is built by
`buildViewMutation`, which the set-op fan never reaches). So today the inner `k.k0_0` reference
binds to the outer-injected `__vmupd_keys` (view-output columns) and throws
`k.k0_0 isn't a column`. That is the un-diagnosed internal error the reject ticket gates out.

Composition resolves it by having the set-op write path **build the inner capture itself** for a
join branch, with a fresh name, and bubble it up so the runtime materializes it:

```
outer set-op capture  __vmupd_keys      = π_{view cols + flags}( σ_{userWhere}( setOpRoot ) )      [primary capture]
inner branch capture  __vmupd_keys$N    = π_{k<side>_<j>}( σ_{memberExists}( branchJoinNode ) )    [nested capture]
                                            └── memberExists references __vmupd_keys (the outer)
branch base ops       update t_side ... where exists(select 1 from __vmupd_keys$N k where k.k<side>_<j> = t_side.<pk_j> …)
```

The inner capture's filter is the SAME `buildMemberExists` predicate (data-tuple NULL-safe match
against the outer capture, plus any subtree gate flags) the single-source fan already builds —
reused verbatim as the inner capture's `where`, so the join branch touches exactly the captured
affected rows, Halloween-safe and order-independent across the branch's own base ops.

## Design

### Branch classification (`set-op.ts`, `buildBranch`)

- Stop rejecting a non-nested join leg. Add `readonly isMultiSource: boolean` to `SetOpBranch`,
  set from `isJoinBody(effectiveSelect)` (a NESTED subtree operand keeps `isNested: true` and its
  join LEAVES are reached as non-nested multi-source branches via `analyzeSetOpBranches` →
  `buildBranch`, so this covers every leaf at every depth — same recursion the reject gate
  relied on).
- `branchColumnNames` / `tryBranchColumnNames`: a join leg's data columns are still its plain
  (optionally renamed) projected columns — a join leg projects `j1.a as a, j2.c as c`. Confirm
  the existing positional name extraction works over a join leg's projection (it should — it
  reads `rc.alias ?? rc.expr.name`). A `select *` join leg stays rejected (no static name list).

### Building the per-branch inner capture + base ops (`set-op.ts` fan helpers)

The fan helpers (`fanBranchDataUpdate`, `fanBranchDelete`, `buildBranchMembershipInsert`, the
insert-through builder, and the flag-less leg builders) currently build an AST stmt against
`branch.view` and call `propagate(ctx, branch.view, …)`, returning `BaseOp[]`. For a
`isMultiSource` branch, do NOT go through plain `propagate` (it builds no capture). Instead
replicate `buildViewMutation`'s mini-orchestration for the branch:

1. `analyzeJoinView(ctx, branch.view)` — the join analysis for the branch body.
2. Mint a fresh inner capture name (`makeNestedCaptureName(depthCounter)` →
   `` `${MS_UPDATE_KEYS_CTE}$${n}` ``), monotonically per join branch in the statement (thread a
   small counter through the fan so multiple join branches don't collide).
3. Build the branch base ops via `decomposeUpdate` / `decomposeDelete` (UPDATE/DELETE) — passing
   the branch's lowered stmt whose `where` is `buildMemberExists(...)` — and the fresh capture
   name, so the base-op predicates reference `__vmupd_keys$N`.
4. Build the inner capture via `buildMultiSourceKeyCapture(ctx', branch.view, memberExists,
   joinAnalysis, sides, sourceValues?, name)` where `ctx'` has the OUTER `__vmupd_keys` injected
   into `cteNodes` (so the inner capture's `memberExists` filter resolves to the outer capture).
   The captured sides are the sides the branch base ops target (`capturedSideIndices`).
5. Bubble the inner capture object up. Extend `SetOpWritePlan` with
   `readonly nestedCaptures?: MultiSourceKeyCapture[]` (accumulated across all join branches) so
   `buildSetOpMutation` can pass them to the node.

Because the existing fan helpers thread plan-building through `propagate` (which returns AST
BaseOps that `buildSetOpMutation` later re-plans under `withKeyCapture`), the cleanest seam is:
for a multi-source branch, the helper returns the SAME `BaseOp[]` shape (AST update/delete
against the base tables — `decomposeUpdate`/`decomposeDelete` already return `BaseOp[]`) AND
records the inner capture into the accumulating `nestedCaptures` list. `buildSetOpMutation` then
builds each base op under a context with BOTH the outer (`withKeyCapture(outer)`) and every
inner (`withKeyCapture(inner_i)`) injected — a base op of branch `N` references `__vmupd_keys$N`,
which must resolve. (A base op only references its own branch's inner name, but injecting all is
harmless — distinct names.)

### Wiring (`view-mutation-builder.ts`, `buildSetOpMutation`)

- After `writeFn` returns `{ baseOps, capture, nestedCaptures }`: build `opCtx` injecting the
  outer `capture` AND each `nestedCaptures[i]` under its own `relationName`.
- Pass `capture` as the node's primary `identityCapture` and `nestedCaptures` (mapped to
  `IdentityCapture { source, descriptor }`) as the node's `nestedCaptures` list — materialized
  outer-first, then each inner (whose source scans the outer), then the base ops.
- Insert-through (`buildInsertThrough`) carries no outer capture; a join-leg insert-through is a
  plain per-branch INSERT routed by the multi-source insert envelope. **Scope decision:** the
  multi-source INSERT path needs the plan-level shared-surrogate envelope
  (`buildMultiSourceInsert`), which the set-op AST `BaseOp[]` fan does not produce. A join-leg
  **insert-through** (membership `set <flag>=true`, flag-less consistent-leg insert, and the
  VALUES insert-through) therefore needs the envelope per active join leg. If that proves too
  large to land with the UPDATE/DELETE composition, split it: ship DELETE + data-UPDATE +
  membership `=false` (the capture-driven fan) in THIS ticket and file a follow-up
  `set-op-write-multisource-leg-insert` for the envelope-backed insert legs. Decide during
  implementation based on size; do NOT leave insert silently broken — if deferred, the join-leg
  insert path must keep a clean structured reject (not the internal error), and the static
  `is_insertable_into` surface must report `NO` for a body with a join leg until insert lands.

### Static surfaces (`func/builtins/schema.ts` + `set-op.ts` probes)

- `isOperandWritable` (membership path) and `isWritableLeafLeg` (flag-less path): drop the
  `isJoinBody` → `false` gate so a join leg reports writable. A join leg's data columns map to
  base columns on their owning side, so `column_info` should report each plain leg column
  `is_updatable = YES` with its base table/column; a literal discriminator stays read-only.
- Gate `is_insertable_into` on whether insert-through is shipped for join legs (see the insert
  scope decision above): if deferred, keep insert `NO` while update/delete report `YES`.
- The surfaces must MATCH the dynamic truth exactly — no over-claim (report writable only for the
  ops that actually compose) and no internal error.

## Edge cases & interactions

- **Multiple join branches in one statement.** Each needs its OWN fresh inner capture name and
  descriptor (`__vmupd_keys$1`, `__vmupd_keys$2`). The monotonic counter must not reset between
  branches; two branches sharing a name re-introduces the original collision.
- **One join branch + one single-source branch.** The single-source branch reads the OUTER
  capture (`__vmupd_keys`) directly; the join branch reads its inner `__vmupd_keys$N`. Both must
  resolve in the same lowered statement — pin a `93.6` case with a join leg AND a plain leg.
- **Nested subtree operand whose LEAF is a join.** `analyzeSetOpBranches` → `buildBranch` reaches
  the leaf as a non-nested multi-source branch; the fan recursion (`fanBranchDataUpdate` /
  `fanBranchDelete`) must build an inner capture for that deep leaf too. Cover a union-all chain
  whose 3rd leg is a join (the shape `93.6`'s `DV` reject currently asserts).
- **`except` / `intersect` subtree gate flags + a join leaf.** The `gateFlags` AND-ed into
  `buildMemberExists` must also feed the inner capture's filter (the inner capture's `where` is
  the same memberExists, gate flags included), so the join leaf fan stays membership-gated.
- **Both-sides data update on a join leg.** A leg `j1.a as a, j2.c as c`; `update V set a=…, c=…`
  fans to BOTH base sides of the leg → two base ops over the inner capture. The inner capture
  must project both sides' PKs (`capturedSideIndices` over the leg's base ops), and the ordered
  materialization (outer → inner → base ops) guarantees the first base op can't empty the join
  out from under the second (the soundness the multi-source capture exists for).
- **Composite-PK / self-join leg.** The inner capture projects one column per PK column per side
  (`keyColumnName`); a self-join leg (one base table under two aliases) routes by alias. These
  are already handled by the multi-source machinery — confirm they flow through the inner
  capture unchanged (a `93.6` composite-PK join-leg case is good coverage).
- **Outer join leg.** A LEFT/RIGHT join leg is a decomposable join body (`isDecomposableJoinBody`
  admits it). A non-preserved-column write through it defers (`unsupported-outer-join-update`) —
  the same diagnostic the standalone path raises; it must surface cleanly through the set-op fan,
  not as an internal error. Decide whether to scope outer-join legs IN or defer them to a
  follow-up; if deferred, gate them in the branch classifier with a clean reject and keep the
  static surface honest.
- **Halloween / order independence within the branch.** The inner capture is materialized before
  the branch's base ops, so a data update that rewrites a column its own member-exists filtered
  on still matches by captured identity. Pin a case that updates a leg's join-key-adjacent column.
- **RETURNING.** Set-op writes reject RETURNING in v1 (`rejectReturning`); unchanged — a join leg
  does not lift that.
- **No regression to single-source / flag-less non-join legs.** The capture-name default and the
  ordered-capture empty-list path keep every existing set-op write byte-identical.

## Tests (flip the reject sections to positive coverage)

- `93.4-view-mutation.sqllogic` ~L3971-4012 (`MV`, the membership join-branch reject): replace
  the all-`NO` surfaces + `error: multi-source (join) leg` asserts with positive coverage —
  `view_info`/`column_info` report the join branch writable; `delete from MV where inL=true`,
  `update MV set x=x+1 where inL=true`, and (if shipped) `insert … inL=true` actually mutate the
  right base rows (`mj1`/`mj2`). Assert the base-table contents after each.
- `93.6-set-op-flagless-write.sqllogic` ~L258-320 (`JV` depth-1 join leg, `DV` depth-3 join
  leg): flip the all-`NO` surfaces and add delete / data-update / insert (if shipped) through the
  flag-less join leg, asserting base-row mutation. Add a mixed case (one join leg + one plain
  leg) and a composite-PK / self-join leg case.
- Add a case that exercises TWO join branches in one body (distinct inner capture names).
- Update `docs/view-updateability.md` § Set Operations: the join-leg branch is now composed via
  an inner per-branch capture chained off the outer set-op capture; remove the "rejected pending
  set-op-write-multisource-leg-compose" language and document the chained-capture mechanism.

## TODO

- Remove the join-leg reject gate: the `isJoinBody` checks in `isOperandWritable`,
  `isWritableLeafLeg`, and `buildBranch` (`set-op.ts`).
- Add `isMultiSource` to `SetOpBranch`; classify a non-nested join leg as multi-source.
- Build the per-branch inner capture (`analyzeJoinView` + `decomposeUpdate`/`decomposeDelete` +
  `buildMultiSourceKeyCapture` with a fresh `__vmupd_keys$N` name, filtered by the branch's
  `buildMemberExists`), under a context with the outer capture injected.
- Extend `SetOpWritePlan` with `nestedCaptures`; accumulate one per join branch.
- Wire `buildSetOpMutation` to inject outer + every inner capture into the base-op context and
  pass `nestedCaptures` to `ViewMutationNode`.
- Decide insert-through-into-join-leg scope: ship with the envelope, or defer to
  `set-op-write-multisource-leg-insert` with a clean reject + honest `is_insertable_into=NO`.
- Restore the static surfaces (`set-op.ts` probes + `schema.ts`) to report a join-leg set-op body
  writable for the ops that compose; keep them matching the dynamic truth.
- Flip the `93.4` / `93.6` reject sections to positive coverage; add mixed-leg, deep-leaf,
  composite-PK/self-join, and two-join-branch cases.
- Update `docs/view-updateability.md` § Set Operations.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`.
- `yarn workspace @quereus/quereus lint`.
