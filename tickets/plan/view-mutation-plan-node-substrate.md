----
description: Build the plan-node-threaded view-mutation substrate that `view-updateability-phase-1` deliberately deferred — `updateLineage` / `AttributeDefault` on `PhysicalProperties` threaded through `computePhysical` (TableReference / Project / Filter / Join), a `propagate.ts` visitor that emits an ordered `BaseOp[]` from a planned (not AST-rewritten) view body, and a `ViewMutationNode` orchestrator (+ `runtime/emit/view-mutation.ts`) that sequences multiple base ops with conflict composition, FK ordering, and RETURNING capture. The backward surface is threaded as the DERIVED dual of each operator's forward FD walk (per `bx-operator-model-and-roundtrip-laws`) — shared FD/EC annotation, law-gated, authored as a get→put derivation toward that spike's committed auto-derivation north-star — NOT a parallel hand-maintained walk. DECISION (resolving this ticket's prior open question): the Phase-1 AST rewrite (`building/view-mutation.ts`) is RETIRED — the substrate is the single path for ALL view mutations (single- and multi-source); the rewrite is removed once the substrate proves single-source parity. The Phase-2 `quereus.update.*` override surface validates through the typed reserved-tag registry. This is the multi-source Phase-2 foundation. Design source: `docs/view-updateability.md` § Implementation Surface.
prereq: bx-operator-model-and-roundtrip-laws, reserved-tag-namespace-typed-registry
files: docs/view-updateability.md, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/emit/explain.ts, packages/quereus/src/util/serialization.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/test/property.spec.ts
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

## Decision gate: the backward surface is DERIVED, not a second hand-walk

This ticket is the **fork** the `bx-operator-model-and-roundtrip-laws` spike
governs. The naïve reading of the bullet below — "each operator's `computePhysical`
also populates `updateLineage`" — would create a **second per-operator walk living
right next to the forward FD walk, hand-maintained, with a soundness net (Key
Soundness) on only the forward one**. The spike rejects that. Per its Tier-B
recommendation, this ticket threads the backward surface as the **derived dual of
the forward operator walk**:

- There is **one** FD/EC/domain annotation per node — the `PhysicalProperties.fds`
  the forward `computePhysical` already produces. The backward method **reads that
  annotation**; it does not re-derive or hand-duplicate its own. Project's `put`
  inverts exactly the scalars `scalar-invertibility.ts` classifies and threads keys
  along exactly the FDs the forward pass emitted; Filter's `put` routes
  constant-FD defaults from the same `∅ → c = v` guarded FDs the forward Filter
  produced; Join composes per-source lineage along the join FDs `propagateJoinFds`
  already computes.
- The **round-trip law** (`bx-roundtrip-law-harness`, extended here to the planned
  multi-source tree) is the **acceptance gate** that this derivation actually
  round-trips. A new operator's backward method is not "done" until PutGet / GetPut /
  lineage-agreement are green over a planned tree that surfaces it.

This is the Bohannon–Pierce–Vaughan move (the spike's cited reference): the
operator's FD/predicate *type* determines both directions, and the laws are checked
rather than assumed. Per the spike's committed **north-star**, each backward method is
authored as a get→put *derivation* from the shared forward annotation — shaped so the
eventual mechanical auto-deriver (Voigtländer-style) is a refactor behind the same law,
never an unwind. This ticket hand-writes each backward method (the auto-deriver itself is
sequenced later, gated on the operator set stabilizing) but **no operator may introduce a
backward rule that auto-derivation could not later reproduce**.

## Decision gate: retire the AST rewrite — the substrate is the single path

This ticket previously left open whether the Phase-1 AST rewrite is retired in favour
of the substrate or kept as a fast path. **Decision: retire it.** The substrate becomes
the single propagation path for **all** view mutations — single- and multi-source — and
`building/view-mutation.ts` (the Phase-1 AST rewrite) is removed once the substrate proves
parity on the single-source shape. Rationale: one code path is the elegance goal; a
permanent two-tier dispatcher (AST fast path + substrate) is exactly the
two-codepaths-for-one-semantics debt the rest of the engine avoids, and it is what the
`bx` derived-dual discipline exists to eliminate — a single derived backward walk per
operator, not an AST special-case beside it.

- **`propagate.ts` is the sole entry.** Every view-targeted DML — including the
  single-source projection-and-filter shape Phase 1 handled by AST rewrite — plans to a
  body and propagates through the substrate. For single-source the result is a
  `ViewMutationNode` over exactly one `BaseOp`, which must match the retired rewrite's
  behavior bit-for-bit (conflict / FK / RETURNING / mutation-context parity).
- **Migration is part of this ticket.** Retiring `building/view-mutation.ts` means
  migrating its callers: the Phase-1 view-DML builders **and**
  `materialized-view-rowtime-write-through` (which reuses the same rewrite). The latter
  rides the AST rewrite until this ticket lands, then moves to the substrate with no
  behavior change.
- This is documented in `docs/view-updateability.md`: the AST rewrite is retired; the
  substrate's single-source case is its trivial (one-base-op) path.

## What the substrate is (per docs/view-updateability.md)

- **`updateLineage` / `AttributeDefault` on `PhysicalProperties`**, populated by
  each operator's backward method as the *derived dual* described above (TableReference
  seeds base-column lineage; Project rethreads it through the already-classified
  invertible scalars and marks non-invertible outputs computed; Filter contributes
  the constant-FD defaults already on its forward FDs; Join composes per-source
  lineage along its forward join FDs). This lets `query_plan()` surface lineage and
  lets arbitrary operator nesting compose, replacing the AST-shape restriction for the
  multi-source tier.
- **A `propagate.ts` visitor** that walks the *planned* body (not the AST) from the
  user-visible relation to base tables and emits an ordered `BaseOp[]` — the
  multi-source generalization of the current `classifyViewBody` single-source gate,
  and the dispatcher described above.
- **A `ViewMutationNode` orchestrator** (+ `runtime/emit/view-mutation.ts`) over
  reused `DmlExecutorNode`s: sequences base ops, composes conflict resolution
  across ops, orders FK checks, and captures RETURNING.
- **The `quereus.update.*` override surface** (Phase-2 tag overrides: `target` /
  `exclude` / `delete_via` / `policy` / `default_for.<column>`) validates and reads
  through the typed reserved-tag registry from `reserved-tag-namespace-typed-registry`
  — this ticket does NOT hand-roll a tag parser.

## Known blocker to resolve first

Adding `Map`-valued fields (`updateLineage`, attribute→default maps) to
`PhysicalProperties` is unsafe today: `explain.ts` runs `safeJsonStringify(node.physical)`
and `safeJsonStringify` does not handle `Map` (serializes to `{}`; a plain-object
form holding plan-node refs would be circular/huge), and golden-plan snapshots
would churn. Teach `safeJsonStringify` to render `Map`s as a bounded summary and
regenerate golden plans *before* threading the new fields.

## Complement object (feeds the lens prover)

The propagation visitor should expose the **predicate-honest complement** of a view
body as a first-class derived object (the spike's Tier C): the base facts outside
the view's projection/predicate image, in the same FD/predicate vocabulary. This is
nearly free once the backward walk exists, and it is what
`3-lens-prover-and-constraint-attachment` consumes so its "Round-trip (lens laws)"
check is *computed* over the complement rather than enumerated as a checklist.

## Acceptance (high level)

- A multi-source view body (e.g. a key-preserving equi-join) decomposes to an
  ordered base-op list and writes through correctly, with conflict/FK/RETURNING
  parity to hand-written base DML.
- `query_plan()` surfaces per-output-column lineage.
- The `bx-roundtrip-law-harness` round-trip block, extended to the planned
  multi-source tree, is green for every operator the substrate threads (this is the
  derived-put acceptance gate, not an optional extra).
- Phase 1's single-source cases continue to pass, now routed **through the substrate**
  (regression assertion: a single-source projection-filter view write constructs a
  `ViewMutationNode` over exactly one `BaseOp` with conflict / FK / RETURNING /
  mutation-context parity to the retired AST rewrite, and `building/view-mutation.ts` is
  removed).
- Any `quereus.update.*` tag on a view / branch / join / dml is validated through the
  reserved-tag registry; an unknown or mis-sited reserved key produces a sited
  diagnostic.
