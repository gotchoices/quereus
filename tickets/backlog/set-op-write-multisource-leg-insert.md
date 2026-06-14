description: Compose INSERT-through into a multi-source (INNER join) leg/branch of a set-op view write. The UPDATE / DELETE legs landed in `set-op-write-multisource-leg-compose`; INSERT was deferred because it needs the plan-level shared-surrogate envelope (`buildMultiSourceInsert`) the capture-driven AST `BaseOp[]` set-op fan does not produce. Today a join-leg insert rejects cleanly (`set-op-write-multisource-leg-insert`) and the static `is_insertable_into` surface reports `NO` for any body with a join leg.
prereq: set-op-write-multisource-leg-compose
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: hard
----

## Background

`set-op-write-multisource-leg-compose` unlocked UPDATE / DELETE / membership-`=false` through an
INNER-join leg of a set-op view by composing an **inner per-branch base-PK capture**
(`__vmupd_keys$N`) chained off the outer set-op capture. INSERT into a join leg was explicitly
**deferred** (a clean reject) because the three insert routes —

- membership `set <flag> = true` (`buildBranchMembershipInsert`),
- a flag-less consistent-leg INSERT (`buildFlaglessInsert`), and
- a VALUES insert-through (`buildInsertThrough`),

— would each route to `propagate(ctx, branchView, {op:'insert'})`, which for a join body raises the
internal `unsupported-multisource-insert` ("must be built via buildMultiSourceInsert"). A multi-source
INSERT is NOT an AST `BaseOp[]`: it needs the **plan-level shared-surrogate envelope**
(`analyzeMultiSourceInsert` + `buildMultiSourceInsert` in `view-mutation-builder.ts`) — a materialized
augmented source the sibling base inserts fan out from, with the shared join key minted from the anchor
key column's declared `default` and threaded via the equivalence class.

## Current state (the clean deferral this ticket lifts)

- Dynamic: a join-leg INSERT rejects with `cannot insert through view '…': … multi-source (join) leg …
  deferred to set-op-write-multisource-leg-insert`. Greppable, structured — never the internal error.
- Static: `is_insertable_into` reports `NO` whenever the body has ANY join leg
  (`setOpHasMultiSourceLeg`), so static and dynamic match exactly. `is_updatable` / `is_deletable`
  stay `YES` (the compose ships them).
- The reject lives in three places in `set-op.ts`: `buildInsertThrough` (membership VALUES route,
  up-front `analysis.branches.some(b => b.isMultiSource)`), `buildBranchMembershipInsert` (the
  `set <flag>=true` flip, per-branch `branch.isMultiSource`), and `buildFlaglessInsert` (up-front
  `legs.some(l => l.branch.isMultiSource)`).

## Requirements

- A join-leg INSERT (membership `=true`, flag-less consistent-leg, VALUES insert-through) actually
  inserts into the leg's base tables via the shared-surrogate envelope — one envelope per active
  join leg, sourced from the supplied VALUES row, with the join's shared key minted/threaded per the
  multi-source insert contract (docs/view-updateability.md § Inner Join — Inserts, § Mutation Context).
- The seam is awkward: the set-op fan builds AST `BaseOp[]` that `buildSetOpMutation` re-plans under
  the injected captures, but `buildMultiSourceInsert` produces a `PlanNode` (an envelope-backed
  `ViewMutationNode`), not a `BaseOp`. Decide how a per-leg envelope composes with the outer set-op
  `ViewMutationNode` — likely the set-op write plan must carry per-join-leg envelope sub-plans the
  outer node sequences, or the join-leg insert routes to a nested `buildMultiSourceInsert` whose
  output is spliced in. This is the core design question.
- Flip `is_insertable_into` to `YES` for a body whose join legs are all insertable (gating still
  `NO` for a subtree operand — `set-op-membership-nested` — and for an outer-join leg).
- Composite-PK shared-key insert stays `unsupported-decomposition-key` (the envelope threads a
  single-column key — inherited from the multi-source insert path).

## Use cases / validation

- Flip the `93.6` JV / DV / CV insert-deferred rejects (`-- error: set-op-write-multisource-leg-insert`)
  to positive coverage: `insert into JV (id, x, src) values (5, 50, 'a')` lands rows in BOTH jv1 and
  jv2 (the join leg's two base tables) via the shared key; assert base-table contents.
- Flip the `93.4` MV membership insert-deferred reject: `insert into MV (id, x, inL, inR) values
  (5, 50, true, false)` inserts into the join branch's base tables.
- A mixed body (one join leg insertable + one plain leg) inserts through whichever the routing selects.
- A join leg whose shared key has no declared `default` and is not supplied rejects `no-default`
  (inherited from `requireKeyDefault`).
- Confirm static `is_insertable_into` matches the dynamic accept/reject exactly per shape.

## Out of scope

- OUTER (left/right/full) / cross / non-equi join legs (a separate deferral of the compose — they
  reject cleanly at branch classification today).
