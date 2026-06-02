description: Scope the runtime lens parent-side FK machinery (cascade walker, RESTRICT pre-check, AND the divergent-basis-FK suppression) so it fires ONLY for lens-routed writes, not basis-direct DML — making it consistent with the plan-time lens RESTRICT side and with logical CHECK constraints (all enforced at the lens boundary only). Threaded via a plan-time `lensRouted` marker on `DmlExecutorNode`, set by the view-mutation lowering when the target resolves to a lens slot.
prereq: lens-parent-side-fk-cascade-actions
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Problem

Three runtime sites in `runtime/foreign-key-actions.ts` consult the lens reverse-map
keyed purely on **basis-table identity**, so they leak onto **basis-direct DML** (a
write straight to the basis table `y.parent`, bypassing the logical view `x.parent`):

1. `executeLensForeignKeyActions` (the cascade walker, fired from
   `executeForeignKeyActionsAndLens` after every basis row delete/update) — propagates
   the logical CASCADE / SET NULL / SET DEFAULT.
2. `assertLensRestrictsForParentMutation` (the runtime lens RESTRICT pre-check, fired
   from `assertTransitiveRestrictsForParentMutation` before the basis op) — rejects a
   logical RESTRICT over a non-restrict basis FK.
3. `basisFksOverriddenByDivergentLensFk` (`schema/lens-fk-discovery.ts`) — **suppresses**
   the physical basis FK action so a divergent logical action wins. Used in
   `executeForeignKeyActions`, `assertNoRestrictedChildrenForParentMutation`, and the
   recursion-skip inside `assertTransitiveRestrictsForParentMutation`.

All three are *runtime, basis-table-keyed*. The plan-time lens RESTRICT collector
(`collectLensParentSideForeignKeyConstraints`) and the logical CHECK collector
(`collectLensRowLocalConstraints`), by contrast, attach **only** when the
view-mutation-builder lowers a write through a lens view — so they are already
lens-path-scoped and a basis-direct write is never subject to them.

The divergence: a basis-direct `delete from y.parent` currently fires the logical
cascade (3 above leaks the same way) even though the basis table declares the relevant
FK semantics on no logical contract. Worse, site 3 introduces a **soundness hole** under
this fix's lens: a basis-direct write today suppresses the physical basis FK (because a
divergent logical FK exists) yet — once the cascade walker is gated off — would run *no*
action at all. So sites 1, 2, **and** 3 must be gated together.

## Decision (settled in plan): the lens is the contract boundary

Logical FK semantics apply **only to writes through the lens**; basis-direct DML is
"raw" and bears only physical (basis-declared) FK semantics — consistent with logical
CHECK (`docs/lens.md` § Constraint Attachment) and the already-lens-scoped logical
RESTRICT. See the plan ticket for the full rationale.

## Design: a plan-time `lensRouted` marker on `DmlExecutorNode`

A through-lens write is *lowered* to a basis write (the single-source spine re-plans to
the basis table), so by the time the runtime sees the basis row delete/update the lens
origin is gone. We recover it with a marker computed at plan time and carried on the
executor node:

```
buildViewMutation(view)                      // sole entry for view-mediated DML
  isLensWrite = !!schema.getLensSlot(view.name)   // same predicate the lens collectors use
    └─ buildBaseOp(..., lensRouted = isLensWrite)
         └─ buildInsertStmt / buildUpdateStmt / buildDeleteStmt(..., lensRouted)
              └─ new DmlExecutorNode(..., lensRouted)   // plan-time flag

emitDmlExecutor(plan)
  const lensRouted = plan.lensRouted
    ├─ executeForeignKeyActionsAndLens(db, table, op, old, new, lensRouted)
    │     ├─ executeForeignKeyActions(...)            // physical, ALWAYS
    │     └─ if (lensRouted) executeLensForeignKeyActions(...)   // site 1, gated
    └─ assertTransitiveRestrictsForParentMutation(db, table, op, old, new, lensRouted)
          ├─ suppressed = lensRouted ? basisFksOverriddenByDivergentLensFk(...) : ∅   // site 3
          ├─ assertNoRestrictedChildrenForParentMutation(..., lensRouted)             // site 3
          ├─ if (lensRouted) assertLensRestrictsForParentMutation(...)                // site 2
          └─ recurse(..., lensRouted = false)   // physical-cascade levels are basis-direct
```

### Why `isLensWrite = !!getLensSlot(view.name)` is the right predicate

`getLensSlot` is exactly the predicate every `lens*Constraints` collector already uses to
decide lens-routed-ness (see `view-mutation-builder.ts:272/286/306/318`). A plain
updatable view or MV write-through lowers to a basis write too, but has no lens slot ⇒
`lensRouted = false` ⇒ basis-only FK semantics (unchanged behavior). Ordinary base-table
DML never goes through `buildViewMutation`, so its builders get the `lensRouted = false`
default.

### Why nested transitive recursion passes `lensRouted = false`

`assertTransitiveRestrictsForParentMutation` recurses through **physical** cascading
child FKs. Those physical cascades, when they execute, issue basis-table SQL via
`executeSingleFKAction` → `db._execWithinTransaction` — i.e. **basis-direct** writes that
re-enter the executor with their own `lensRouted = false` marker. So the pre-walk's nested
levels are physical-cascade/basis-direct and must pass `false`. A genuine *logical*
cascade re-enters through the logical child view (`issueLensFkAction` issues `delete from
x.child`), which lowers through `buildViewMutation` again and gets a fresh
`lensRouted = true` marker — so logical transitivity is preserved without the physical
recursion carrying the lens flag. The top-level invocation's own `suppressed` set and
step-1b lens RESTRICT scan still use the real `lensRouted` value.

### Self-consistency of the lens cascade re-entry

The cascade walker issues DML against the logical child *view* (`issueLensFkAction`), which
re-enters `buildViewMutation` → `lensRouted = true` on the nested executor → the nested
cascade/RESTRICT fire correctly. A divergent-FK-suppressed basis cascade at the top level
is skipped (top-level `suppressed` non-empty under `lensRouted = true`) and the logical
action replaces it via this re-entry — unchanged from today for the through-lens path.

## Scope / boundaries

- Multi-source / decomposition lens parents resolve to **no single basis spine**, so the
  reverse-map (`resolveSlotBasisSource`) never matches them anyway — the existing
  documented boundary, identical to the plan-time RESTRICT collector. Their dedicated
  builders (`buildMultiSourceInsert` / `buildDecompositionInsert`) may leave
  `lensRouted = false`; harmless because no parent-side cascade can match a multi-source
  parent. Only the single-source spine (`buildBaseOp`) needs the marker. (Note this in a
  code comment so a future reader does not "fix" the omission.)
- `DmlExecutorNode.withChildren` must reconstruct the new `lensRouted` field, or the
  optimizer drops it on any node rebuild — easy to miss; add a regression assertion.

## TODO

### Phase 1 — thread the marker through the plan

- Add `public readonly lensRouted: boolean = false` to `DmlExecutorNode`
  (`planner/nodes/dml-executor-node.ts`) as a new trailing constructor param; propagate it
  in `withChildren`; surface it in `getLogicalAttributes` (debug visibility).
- Add a trailing `lensRouted = false` param to `buildInsertStmt` / `buildUpdateStmt` /
  `buildDeleteStmt` and pass it into every `new DmlExecutorNode(...)` they construct
  (insert.ts:652, update.ts:357 & :404, delete.ts:205).
- In `buildViewMutation` (`view-mutation-builder.ts`): compute
  `const isLensWrite = !!ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);`
  once, and thread it through `buildBaseOp` into the three base-table builders.

### Phase 2 — gate the three runtime sites on `lensRouted`

- `executeForeignKeyActionsAndLens`: add a `lensRouted: boolean` param; call
  `executeLensForeignKeyActions` only when `lensRouted` (physical
  `executeForeignKeyActions` stays unconditional).
- `assertTransitiveRestrictsForParentMutation`: add a `lensRouted: boolean` param
  (before the existing `visited`). Compute `suppressed` only when `lensRouted` (else empty
  set); fire step-1b `assertLensRestrictsForParentMutation` only when `lensRouted`; pass
  `lensRouted = false` on the recursive call.
- `assertNoRestrictedChildrenForParentMutation` and `executeForeignKeyActions`: add a
  `lensRouted: boolean` param and compute `basisFksOverriddenByDivergentLensFk` only when
  `lensRouted` (else empty set). (Both are also reachable from
  `processEvictions`/elsewhere — pass `false` there, an internal REPLACE eviction is a
  physical basis effect.)
- Update `emitDmlExecutor` (`dml-executor.ts`) to read `plan.lensRouted` and pass it to
  `executeForeignKeyActionsAndLens` and `assertTransitiveRestrictsForParentMutation` at
  all call sites (the insert-upsert/replace, update, delete, and eviction paths). The
  `processEvictions` calls are physical evictions ⇒ pass `false`.

### Phase 3 — tests (`packages/quereus/test/lens-enforcement.spec.ts`)

Add a `describe('lens enforcement: parent-side FK is lens-routed-only (basis-direct DML bears only basis FKs)')` block. Use the existing `deployDivergentFkLens` / `deployLensRestrictOverBasis` / `rows` helpers where they fit. Key cases and expected outcomes:

- **Cascade does NOT fire on basis-direct delete (the headline gap).** Logical FK
  `on delete cascade`, basis has **no** FK. Insert through the lens
  (`x.parent`/`x.child`), then `delete from y.parent where id = 1` (basis-direct). Expect
  the basis child row to **survive** (logical cascade did not fire). Contrast: the same
  delete through `x.parent` **does** cascade the child away.
- **Cascade still fires through the lens** (regression guard for the unchanged path):
  `delete from x.parent` removes the logical child.
- **Runtime lens RESTRICT does NOT fire on basis-direct delete.** Reuse
  `deployLensRestrictOverBasis` (logical RESTRICT over a basis `on delete cascade`). A
  referenced `delete from x.parent` ABORTs (unchanged); the same `delete from y.parent`
  basis-direct **succeeds** and the basis cascade fires per the *basis* action.
- **Divergent-suppression soundness on basis-direct write (site 3 — the new hole this
  fix closes).** Logical SET NULL over basis CASCADE (`deployDivergentFkLens`). Through
  the lens, `delete from x.parent` nulls the child (logical wins). Basis-direct
  `delete from y.parent` must apply the **basis** CASCADE (delete the child) — NOT be
  suppressed into a no-op. Assert the child is gone (basis action), proving the physical
  FK is no longer suppressed for a basis-direct write.
- **UPDATE variants** of the cascade + divergent cases (re-key the parent via
  `y.parent` vs `x.parent`), mirroring the existing UPDATE divergent tests.
- **Nested/transitive** smoke: a lens-routed parent delete still cascades through a
  logical grandchild (re-entry path intact), while a basis-direct parent delete does not
  touch the logical-only grandchild FK.
- **Plan-node regression:** `DmlExecutorNode.withChildren` preserves `lensRouted` (unit
  assertion — rebuild a node and check the flag survives).

### Phase 4 — docs

- `docs/lens.md` § Constraint Attachment: add an explicit statement that logical FK
  semantics (BOTH sides — child existence and parent RESTRICT/cascade — when the FK is
  `enforced-fk`) apply **at the lens boundary only**; a basis-direct write is governed
  solely by basis-declared FKs. Tie it to the existing `with check option` row (logical
  CHECK has the same boundary rule) so the three classes (CHECK / RESTRICT / cascade) are
  documented as one consistent rule.

### Validation

- `yarn workspace @quereus/quereus run build` then run the lens spec:
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens-test.log` (stream, never
  silent-redirect). Confirm the new block passes and the existing parent-side FK /
  divergent / RESTRICT-runtime blocks are unchanged.
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
