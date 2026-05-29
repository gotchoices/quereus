description: Build the plan-node-threaded view-mutation substrate that `view-updateability-phase-1` deliberately deferred — `updateLineage` / `AttributeDefault` on `PhysicalProperties` threaded through `computePhysical` (TableReference / Project / Filter / Join), a `propagate.ts` visitor that emits an ordered `BaseOp[]` from a planned (not AST-rewritten) view body, and a `ViewMutationNode` orchestrator (+ `runtime/emit/view-mutation.ts`) that sequences multiple base ops with conflict composition, FK ordering, and RETURNING capture. This is the multi-source Phase-2 foundation; Phase 1 shipped a single-source AST rewrite that needs none of it. Design source: `docs/view-updateability.md` § Implementation Surface.
prereq:
files: docs/view-updateability.md, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/emit/explain.ts, packages/quereus/src/util/serialization.ts
----

## Why this exists

`view-updateability-phase-1` shipped single-source projection-and-filter view
writes as an **AST-level rewrite** (`building/view-mutation.ts`): a view-targeted
DML whose body classifies as one base table under pass-through operators is
rewritten to target that base table and re-planned through the ordinary
base-table builder. For the single-source case this is complete and reuses 100%
of the base DML pipeline — an orchestrator over one base op would add no behavior,
so the prescribed plan-node substrate was intentionally **not** wired.

That substrate is still the prerequisite for everything beyond single-source. The
review of Phase 1 confirmed the deferral is acceptable *for Phase 1* but the
foundation must exist before Phase 2 (multi-source fan-out, nested/CTE bodies via
inline-and-propagate, RETURNING-through-views) can land. The AST-rewrite approach
does not generalize: it drives off `selectAst` and therefore cannot see an inner
view/CTE's filters (hence Phase 1 rejects `nested-view`), nor can it sequence
more than one base op.

## What the substrate is (per docs/view-updateability.md)

- **`updateLineage` / `AttributeDefault` on `PhysicalProperties`**, propagated by
  each operator's `computePhysical` (TableReference seeds base-column lineage;
  Project rethreads it through invertible scalars and marks non-invertible outputs
  computed; Filter contributes constant-FD defaults; Join composes per-source
  lineage). This lets `query_plan()` surface lineage and lets arbitrary operator
  nesting compose, replacing the AST-shape restriction.
- **A `propagate.ts` visitor** that walks the *planned* body (not the AST) from the
  user-visible relation to base tables and emits an ordered `BaseOp[]` — the
  multi-source generalization of the current `classifyViewBody` single-source gate.
- **A `ViewMutationNode` orchestrator** (+ `runtime/emit/view-mutation.ts`) over
  reused `DmlExecutorNode`s: sequences base ops, composes conflict resolution
  across ops, orders FK checks, and captures RETURNING.

## Known blocker to resolve first

Adding `Map`-valued fields (`updateLineage`, attribute→default maps) to
`PhysicalProperties` is unsafe today: `explain.ts` runs `safeJsonStringify(node.physical)`
and `safeJsonStringify` does not handle `Map` (serializes to `{}`; a plain-object
form holding plan-node refs would be circular/huge), and golden-plan snapshots
would churn. Teach `safeJsonStringify` to render `Map`s as a bounded summary and
regenerate golden plans *before* threading the new fields.

## Acceptance (high level)

- A multi-source view body (e.g. a key-preserving equi-join) decomposes to an
  ordered base-op list and writes through correctly, with conflict/FK/RETURNING
  parity to hand-written base DML.
- `query_plan()` surfaces per-output-column lineage.
- Phase 1's single-source cases continue to pass (the AST rewrite may be retired
  in favour of the substrate, or kept as a fast path — design decision for this
  ticket).
