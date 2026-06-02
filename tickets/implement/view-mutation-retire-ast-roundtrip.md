description: Phase B2 of the derived-backward-walk. Retire the lossy plan→AST→re-plan double-plan in the multi-source `update` / `delete` path: build the per-side base writes and the per-side row-identifying predicate from the ALREADY-planned body node (`analyzeJoinView`'s `root`) and the threaded `updateLineage` / `viewComplement`, instead of lowering decisions back to AST `BaseOp`s whose join body is re-planned inside every identifying subquery. Keep `ViewMutationNode` + the base-table builders for the actual base writes — the goal is to stop *re-deriving via AST*, not to stop reusing the base writers. Acceptance gate: behavioral parity over the View Round-Trip Law harness (Tier A unaffected; Family B PutGet / GetPut / lineage-agreement green) with the double-plan gone.
prereq: view-mutation-multisource-threaded-updatesite
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## Context (Phases A + B1 have landed)

Phase A: the shared `scope-transform.ts` substitution primitive. Phase B1: the
multi-source path consumes the full `UpdateSite` (incl. `inverse` / `domain`) for column
routing + assignment inversion, but **still lowers to AST and re-plans**. This ticket
removes that double-plan.

## The debt this closes (the architectural tension)

`multi-source.ts` today:
1. `analyzeJoinView` calls `buildSelectStmt(ctx, sel)` to plan the body (**plan #1**) and
   reads `root.physical.updateLineage`.
2. `decomposeUpdate` / `decomposeDelete` build per-side AST statements whose WHERE is
   `<pk> in (select <pk> from <body-AST> where <idPredicate>)` — the body AST is cloned
   in (`cloneFromClause(analysis.sel.from)`).
3. `buildBaseOp` → `buildUpdateStmt` / `buildDeleteStmt` **re-plans** each AST statement,
   re-planning the body inside every identifying subquery (**plan #2+**). The identity
   capture and the RETURNING re-query each plan the body again.

This double-plans and historically discarded the richer lineage (B1 fixed the discard;
this fixes the double-plan). The decided north-star
(`docs/view-updateability.md` § Round-Trip Laws and the Derived Backward Walk) is for the
substrate to **walk the plan node's backward methods directly** — the derived dual of
each operator's forward FD walk — not round-trip through AST.

## Required behavior

Make the multi-source `update` / `delete` substrate build its per-side base writes and
identifying predicates from the **planned body node** (`root` from `analyzeJoinView`) and
its threaded `updateLineage` / `viewComplement`, reusing the already-planned operator
tree for the identifying subquery rather than re-planning a lowered AST body. Where a base
statement is still needed for the actual write, build it from the threaded lineage and
hand it to the base-table builder (the writes still reuse `buildUpdateStmt` /
`buildDeleteStmt`); do not re-derive the body via AST.

Design notes / open questions for the implementer (resolve against the planned tree):
- The identifying predicate per side is the projection of the join's row-identifying
  predicate onto that side's PK columns (§ Identifying Predicates). Today it is
  reconstructed as a SQL subquery over the body AST; the goal is to build it from the
  planned body + `updateLineage` (which already binds each output attr to its owning
  base + the key columns the forward FD walk proved). `viewComplement`
  (`analysis/view-complement.ts`) is the predicate-honest complement object the docs name
  as the consumer surface — use it for the residual predicate where it applies.
- The both-sides identity capture (`buildMultiSourceUpdateKeyCapture`) and the RETURNING
  re-query (`buildMultiSourceUpdateReturning`) currently each re-plan the body via AST.
  Converge them onto the same planned-body consumer so the body is planned **once**.
- Keep the `__vmupd_keys` context-backed key relation, the FK ordering, the `target` /
  `exclude` / `delete_via` / `policy` tag surface, and the scope guards
  (`assertTopLevelViewColumns`) behaviorally identical.
- The `view-complement.ts` / `update-lineage.ts` annotation layer has **landed** — this
  is a consumption change, not new-annotation work. If a needed fact (e.g. a per-side key
  binding) is not yet surfaced on the planned node, prefer threading it onto the existing
  backward surface over re-introducing an AST re-derivation.

If this proves too large even as a standalone ticket, split per concern (update path,
delete path, identity-capture+RETURNING convergence) into further `prereq:`-chained
same-stage tickets — each gated by the law harness.

## Acceptance criteria

- The multi-source path no longer lowers-to-AST-and-re-plans to make backward decisions —
  the body is planned once (grep: no second `buildSelectStmt` of the body inside the
  identifying-subquery / capture / returning lowering; no `cloneFromClause` of the body
  FROM feeding a re-planned base op for the purpose of row identification).
- `yarn workspace @quereus/quereus test` green, including the full View Round-Trip Laws
  block (Tier A + Family B + Family C). **Behavioral parity** with the retired AST path:
  every previously-passing view-mutation test (`93.x-view-mutation*.sqllogic`, the
  multi-source PutGet/GetPut/delete_via/both-sides/returning cases) still passes.
- `yarn workspace @quereus/quereus run lint` clean.
- `docs/view-updateability.md` § Implementation Surface "Forward note" + "Surface
  authority" callout updated to reflect that the substrate now consumes the plan-node
  backward walk, and to name which physical operators (HashJoin / MergeJoin / aggregate /
  set-op / Sort/Limit/Distinct) still degrade lineage and therefore remain rejected — so
  the doc stays honest about the boundary.

## TODO
- [ ] Thread the planned body node + per-side key bindings through `decomposeUpdate` / `decomposeDelete` so the identifying predicate is built from `updateLineage` / `viewComplement`, not a re-planned AST body.
- [ ] Build the per-side base write statements from the threaded lineage and hand to the base-table builders (no AST re-derivation of backward decisions).
- [ ] Converge the both-sides identity capture + the RETURNING re-query onto the same planned-body consumer (plan the body once).
- [ ] Prove behavioral parity over the law harness + the existing view-mutation suites; lint clean.
- [ ] Update `docs/view-updateability.md` (Forward note / Surface authority / degraded-operator boundary).
