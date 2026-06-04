description: Build the per-row conditional materialization substrate — "for each captured row, INSERT the missing component, UPDATE the present one, or DELETE the now-empty one" — and use it to complete two deferred write paths that share it: the outer-join non-preserved-side UPDATE (null-extended row → insert) and the decomposition optional-member / EAV UPDATE.
prereq: view-write-outer-join-static
files: packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Why

`docs/view-updateability.md` § Outer Joins specifies that an update on a non-preserved-side column splits **per row**: where the guard holds it is an ordinary base update; where the row is null-extended (the non-preserved side had no match) the update is **rewritten as an insert** on that side. `docs/lens.md` / `decomposition.ts` describe the dual for optional/EAV members: a null→non-null update **materializes** a member row, a non-null→all-null update **deletes** it. Both are deferred today (`unsupported-outer-join-update` from `view-write-outer-join-static`; `unsupported-decomposition-update` in `decomposition.ts`) for the **same** reason: the `ViewMutationNode` base-op list is a *static* ordered fan-out and cannot express a per-row insert-or-update/delete branch. This ticket builds that branch once and routes both consumers through it.

This is the runtime-heavy ticket of the shape-gaps set. It is intentionally last and may itself decompose during implement (see § Sizing).

## The gap in the runtime model

`ViewMutationNode` (`nodes/view-mutation-node.ts`) holds `baseOps: readonly PlanNode[]` — each a fully-formed base-table DML subtree the emitter drains in order. The capture (`IdentityCapture`) and envelope (`MutationEnvelope`) side inputs are materialized once and read back, but there is **no construct that selects, per captured row, which base op to run**. An outer-join non-preserved update needs exactly: for each affected view row, evaluate the guard against the *pre-mutation* base state; if the non-preserved side matched → `update <nonPreserved> set …`; else → `insert into <nonPreserved> (joinKey via EC, set cols, defaults) …`.

## Target architecture

### A conditional materialization op on the capture

Extend the up-front capture to record, per affected view row: the preserved-side PK identity (already captured) **and** the guard's truthiness against pre-mutation state (i.e. whether the non-preserved side matched). Partition the captured rows into a **matched** set and a **null-extended** set — two derived relations over the one materialized capture (a `Filter` on the guard column), so no second plan of the body.

Add a `ViewMutationNode` shape (a new side structure, parallel to `IdentityCapture` / `MutationEnvelope`) that pairs:
- an **UPDATE base op** keyed on the matched subset (`<nonPreserved>.pk in matched`), and
- an **INSERT base op** sourced from the null-extended subset (an `EnvelopeScanNode`-style projection: join-key columns from the preserved side via EC, `set` columns from the user's assignment, other columns from defaults / `default_for`), reusing the existing envelope projection/build machinery from `buildMultiSourceInsert` / `buildDecompositionMemberInsert`.

The emitter (`runtime/emit/view-mutation.ts`) materializes the capture, then drains the matched-UPDATE and null-extended-INSERT against the same pre-mutation partition. Because both read the eagerly-materialized partition (not live state), ordering between them is immaterial — the same eager-capture guarantee the multi-source both-sides update already relies on (§ Multi-Base-Table Mutations).

### Decomposition optional-member / EAV update (the dual)

`decomposition.ts` `routeAssignment` currently rejects an optional-member / EAV / null-extended target (`unsupported-decomposition-update`). Route it instead through the same conditional substrate:
- optional columnar member: matched (member row exists for the anchor key) → `update <member>`; null-extended (no member row) → `insert <member>` (anchor key via EC + the assigned value + member defaults); a non-null→**all-null** update of every optional column → `delete <member>` (the member row becomes empty). The all-null→delete case adds a third branch (insert-or-update-or-delete) — gate it on "all of the member's optional columns assigned null".
- EAV member: a per-attribute triple is materialized (value non-null) or deleted (value null) — the EAV analogue, reusing the EAV triple insert/delete the decomposition insert/delete fan-out already builds.

Both consumers share the partition-and-branch core; the decomposition path keys the partition off the **anchor** (anchor-resolvable predicate, as today) rather than a join guard.

### Preserved/anchor identity is the partition key

The matched-vs-null-extended decision is made against **pre-mutation** base state and keyed on the preserved-side (or anchor) PK — which is exactly what the existing capture already materializes. So the new work is the partition (a guard/existence column on the capture) + the conditional emit, not a new identity mechanism.

## Sizing

The runtime branch (capture partition + insert-or-update[-or-delete] emit) is the bulk. If the work exceeds one implement pass (BUDGET_WARNING), split **in this same stage** by consumer, prereq-chained: land the outer-join non-preserved update first (`view-write-outer-join-nonpreserved-update`), then the decomposition optional/EAV update (`view-write-decomposition-optional-update`) on the shared substrate. Keep the substrate in `view-mutation-node.ts` + the emitter so both consumers reuse it; do not fork two parallel branch implementations.

## Out of scope (keep rejecting)

- Composite shared keys (`unsupported-decomposition-key`) — unchanged.
- Aggregate / window write propagation — unchanged.
- Multi-source (join) **insert** RETURNING with a minted surrogate — unchanged (`returning-through-view`).

## Tests (acceptance gate: `test/property.spec.ts` § View Round-Trip Laws → the multi-source and decomposition families)

- **Outer-join non-preserved update — matched + null-extended.** On `rj_outer`, `update rj_outer set pv = NV where cc = K` (flip the negative from `view-write-outer-join-static`): a matched row updates the parent; a null-extended row (child with no parent) **inserts** a parent carrying the EC join key + `pv = NV` + parent defaults; PutGet green; a row whose parent insert lacks a `not null`-without-default value fails with `null-extended-create-conflict`.
- **Decomposition optional-member update.** The Car decomposition (`docs/lens.md` CarCore ⟕ CarSpeed, optional speed): `update Car set topSpeed = 200 where id = 7` materializes the CarSpeed row when absent, updates it when present; setting `topSpeed = null` (the only optional column) **deletes** the CarSpeed row; round-trip green over the decomposition family. Flip the decomposition deferral negatives (property.spec ~L4085–4095).
- **Decomposition EAV update.** A null value deletes the triple, a non-null materializes/updates it.
- **Negative self-tests** stay red on injected violations (a materialized side that diverges from the forward image).
- All other deferred shapes continue to **reject** with their precise diagnostic.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log` and `yarn workspace @quereus/quereus lint`. The full property block is the gate; if `yarn test:store` is needed for a store-path interaction, note it for CI rather than running it inline if it risks the idle timeout.

## TODO

- Add a conditional-materialization side structure to `ViewMutationNode` (parallel to `IdentityCapture` / `MutationEnvelope`): a captured partition + a matched-UPDATE op + a null-extended-INSERT op (+ optional all-null-DELETE op); thread it through `getChildren` / `getRelations` / `withChildren` / `computePhysical`.
- Extend the capture to record the guard/existence truthiness per row and expose matched / null-extended partitions as `Filter`s over the one materialized capture.
- Emit (`runtime/emit/view-mutation.ts`): materialize the capture, then drain the partitioned UPDATE / INSERT / DELETE base ops against the pre-mutation partition.
- Multi-source consumer (`multi-source.ts`): replace the `unsupported-outer-join-update` reject with the conditional build for a non-preserved-side assignment; source the null-extended insert's join key via EC, set cols from the assignment, others from defaults / `default_for`.
- Decomposition consumer (`decomposition.ts` `routeAssignment` / `decomposeUpdate`): route optional-member + EAV updates through the shared substrate (insert-or-update, plus all-null→delete); keep key-column and cross-member rejects.
- Builder (`view-mutation-builder.ts`): build the conditional ops + partitions, reusing the envelope projection machinery.
- Add the property-spec accepts above; flip the outer-join non-preserved and decomposition optional/EAV negatives; keep composite-key / aggregate / multi-source-insert-RETURNING negatives red.
- Update `docs/view-updateability.md` § Outer Joins + § Current limitations and `docs/lens.md` § The Default Mapper to reflect optional-member update support; remove the corresponding deferral notes.
- If split for budget: create `view-write-decomposition-optional-update` (prereq `view-write-outer-join-nonpreserved-update`) in `tickets/implement/` and delete this ticket.
