description: Review the multi-source (INNER join) leg compose for set-op view writes. A join branch's UPDATE / DELETE / membership-`=false` now compose by building an inner per-branch base-PK capture (`__vmupd_keys$N`) chained off the outer set-op capture, so the join leg decomposes through the multi-source machinery without colliding with the outer capture. INSERT into a join leg and OUTER/cross join legs are deferred (clean rejects). Static surfaces flipped to match the dynamic write.
prereq: set-op-multisource-capture-relation-name-param, view-mutation-ordered-multi-capture
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: hard
----

## What shipped

Removed the join-leg reject gate (`set-op-write-multisource-leg-reject`) and made an **INNER-join
leg** of a set-op view body writable for **UPDATE / data-UPDATE / DELETE / membership `=false`**, on
BOTH the `exists`-membership path and the flag-less predicate-honest path. The composition resolves the
documented collision: a join branch routed through plain `propagate` builds no capture, so its emitted
multi-source `k<side>_<j>` predicates would bind to the outer set-op capture (view-output columns) — the
internal `k.k0_0 isn't a column` error. Instead the fan builds the join branch itself.

### The mechanism (`set-op.ts`)

- `buildBranch` / `buildFlaglessLeg`: add `SetOpBranch.isMultiSource`, set from `isInnerJoinBody`
  (new export in `multi-source.ts` = `isDecomposableJoinBody` ∧ all joins inner). An OUTER /
  cross / non-equi join leg is rejected cleanly at classification (membership) or drops the body out
  of the flag-less route (`isWritableLeafLeg` returns false → single-source spine reject).
- `fanBranchDataUpdate` / `fanBranchDelete`: thread a `JoinLegFan` (the outer capture + an accumulator
  + a monotonic `__vmupd_keys$N` name minter). A multi-source branch routes to `fanMultiSourceBranch`
  instead of `propagate`: it runs `analyzeJoinView` on the branch body, `decomposeUpdate`/
  `decomposeDelete` against the fresh inner name, then `buildMultiSourceKeyCapture` over the branch
  join body filtered by the SAME `buildMemberExists` predicate (under a context with the OUTER capture
  injected via the shared `withKeyCapture`), and pushes the inner capture into the fan accumulator.
- `SetOpWritePlan.nestedCaptures` carries the inner captures up. `buildSetOpMutation`
  (`view-mutation-builder.ts`) injects the outer + every inner under its own name into the base-op
  context, passes the outer as the primary `identityCapture` and the inners as
  `ViewMutationNode.nestedCaptures` (materialized outer-first then inner — the substrate from
  `view-mutation-ordered-multi-capture`).

### Static surfaces (`set-op.ts` probes + `schema.ts`)

- `isOperandWritable` (membership) / `isWritableLeafLeg` (flag-less): a leaf is writable when
  single-source OR an inner-join leg.
- New `setOpHasMultiSourceLeg` gates `is_insertable_into` to `NO` for any body with a join leg (insert
  deferred), while `is_updatable` / `is_deletable` report `YES`. column_info reports each writable
  column `YES` with a **null base** (the established writable-through-effect convention — see Known
  gaps / deviations).

### Deferred (clean rejects, not internal errors)

- **INSERT** into a join leg (membership `=true`, flag-less consistent-leg, VALUES insert-through):
  needs the plan-level shared-surrogate envelope the AST `BaseOp[]` fan does not produce. Filed as
  `tickets/backlog/set-op-write-multisource-leg-insert.md`. Reject is greppable
  (`set-op-write-multisource-leg-insert`); `is_insertable_into = NO`.
- **OUTER (left/right/full) / cross / non-equi** join legs: rejected at classification (membership) or
  via the flag-less route falling out. Static all-`NO`. Not separately ticketed (a niche extension —
  the multi-source machinery's partial outer-join support exists; composing it into the set-op fan is
  future work).

## Use cases to validate (tests added/flipped)

`93.4-view-mutation.sqllogic`:
- **MV** (membership, mixed: left INNER-join branch + right plain branch): view_info update/delete YES,
  insert NO; data-UPDATE `set x=x+1 where inL=true` updates only mj1 (mj2 untouched); DELETE
  `where inL=true` fans to both mj1 and mj2 (the inner-join lenient ambiguous delete); INSERT deferred.
- **TWO** (membership, BOTH branches INNER joins): a single `update … where id=1` touches both branches
  → distinct inner captures `$1`/`$2` (the monotonic-counter / no-collision requirement).

`93.6-set-op-flagless-write.sqllogic`:
- **JV** (flag-less, join leg + plain leg, literal discriminator `src`): static surfaces; data-UPDATE
  and DELETE through the 'a' join leg; INSERT deferred; discriminator read-only.
- **DV** (deep leaf: union-all chain whose 3rd leg is a join): DELETE through the depth-3 join leg.
- **CV** (composite-PK join leg): inner capture projects `k<side>_0, k<side>_1`; UPDATE + DELETE.
- **SJ** (self-join leg, one base table under two aliases): UPDATE routes by alias to the owning side.
- **HV** (Halloween): UPDATE rewrites the column its member filter ranged on; the up-front inner
  capture freezes identity so no row escapes.
- **OJV** (OUTER join leg deferral): static all-`NO`, dynamic clean reject, base tables untouched.

## Validation performed

- `yarn workspace @quereus/quereus test` → **6314 passing, 9 pending, 0 failing** (memory mode).
- `yarn workspace @quereus/quereus lint` → exit 0 (eslint + `tsc -p tsconfig.test.json`).
- `tsc -p tsconfig.json --noEmit` (main source) → exit 0.
- Behavior discovered/confirmed via throwaway probe scripts (deleted) before pinning exact base-table
  assertions; all five composed scenarios verified to mutate the right base rows.

## Known gaps / deviations for the reviewer

- **column_info reports null base for join-leg columns**, NOT the leg's actual base table/column the
  ticket's prose suggested. This MATCHES the established membership / flag-less convention (every set-op
  view column already reports null base — "writable through effect", since a data column fans to
  possibly several legs/sides with no single base column). Reporting a real base table/column would
  diverge from that convention and over-specify a single owner a fan-out does not have. Deliberate; flag
  if you disagree.
- **DELETE through a join leg fans to BOTH inner-join sides** (the lenient ambiguous-delete default
  inherited from the multi-source spine), e.g. `delete from MV where inL=true` removes the joined row
  from mj1 AND mj2. Documented and asserted; confirm this is the intended set-op delete semantics
  (no FK proves a single child side in the test fixtures).
- **Cross-source SET through a join leg** (`update V set a.x = b.y`) is NOT supported — the fan passes
  `sourceValues=undefined`, so `stripSideQualifier` rejects it cleanly (`cross-source-assignment`). Not
  tested; a v1 limitation matching the standalone path without a carrier.
- **`except`/`intersect` subtree with an INNER-join LEAF**: the gate flags ARE threaded into the inner
  capture's `memberExists` filter (correct by construction — `fanMultiSourceBranch` reuses
  `branchStmt.where` which carries the accumulated gate), but there is **no test** for this specific
  shape (a join leaf inside a flag-gated except/intersect subtree). Reviewer may want to add one.
- **Inner-capture filter substitution** is the highest-risk seam: `buildMemberExists` qualifies branch
  columns with the synthetic branch-view name, and `buildMultiSourceKeyCapture` →
  `substituteViewColumns` rewrites them to base terms (including literal discriminators via
  `viewColToBaseRef`) while leaving the `k.*` outer-capture refs untouched. Verified working across all
  five scenarios, but worth an adversarial read.

## Suggested adversarial checks

- A two-join-branch DELETE (not just UPDATE) — confirm `$1`/`$2` inner captures both materialize and
  tear down (the ordered-capture substrate). (Tested update; delete not.)
- Confirm RETURNING through a join-leg set-op write still rejects (`rejectReturning` is unchanged).
- A join leg whose body itself has a leg-local LIMIT/ORDER BY (stripped by `rightBranchSelect` /
  `stripLegModifiers`?) — confirm it doesn't leak into the inner capture.
- Re-confirm no regression on the existing single-source / flag-less non-join set-op write suites
  (the nested-captures empty-list path must stay byte-identical).
