----
description: Thread the backward update surface onto `PhysicalProperties` as the **derived dual** of each operator's forward FD walk (per `bx-operator-model-and-roundtrip-laws`): add `updateLineage` (per-attribute `UpdateSite`) and an attribute→default map, populated by a backward method on `computePhysical` for TableReference / Project / Filter / Join that READS the forward `PhysicalProperties.fds` rather than re-deriving its own. Project inverts exactly the scalars `scalar-invertibility.ts` classifies and threads keys along the FDs the forward pass emitted; Filter routes constant-FD defaults from its `∅ → c = v` guarded FDs; Join composes per-source lineage along its forward join FDs; TableReference seeds base-column lineage. Surface the lineage through `query_plan()`. Expose the **predicate-honest complement** as a first-class derived object for the lens prover. Extend the `bx-roundtrip-law-harness` block with the *static* forward/backward lineage-agreement check over planned bodies (incl. join) — the dynamic PutGet/GetPut multi-source gate lands with the orchestrator in `view-mutation-substrate-orchestrator`. No new propagation/execution path here: this is the annotation layer the orchestrator consumes. Design source: `docs/view-updateability.md` § The Update Site Model, § Round-Trip Laws and the Derived Backward Walk, § The predicate-honest complement.
prereq: view-mutation-map-serialization, bx-roundtrip-law-harness
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/test/property.spec.ts (PhysicalProperties interface is at plan-node.ts:179; query_plan surfacing flows through the safeJsonStringify(node.physical) call at func/builtins/explain.ts:170)
----

## The discipline this ticket is bound by (read first)

This is the **fork** the `bx-operator-model-and-roundtrip-laws` spike governs. The
naïve reading — "each `computePhysical` also populates `updateLineage`" — would create
a **second per-operator walk** hand-maintained next to the forward FD walk, with the Key
Soundness net on only the forward one. **That is rejected.** There is **one** FD/EC/domain
annotation per node: the `PhysicalProperties.fds` the forward `computePhysical` already
produces. The backward method **reads that annotation**; it does not re-derive or
hand-duplicate its own.

- **Project** inverts exactly the scalar transforms `analysis/scalar-invertibility.ts`
  classifies (`passthrough` / `inverse` / `opaque`), threading keys along exactly the FDs
  `computePhysical` emitted; a non-invertible output is marked `computed`.
- **Filter (σ)** routes constant-FD defaults from the same `∅ → c = v` guarded FDs the
  forward Filter produced — it does not re-scan the predicate AST for `col = literal`.
- **Join** composes per-source lineage along the join FDs the forward pass computed
  (`propagateJoinFds` / the join's emitted equivalence classes), not by re-reading the ON clause.
- **TableReference** seeds base-column lineage (each output attribute → its base column).

**North-star (committed).** Each backward method is authored as a get→put *derivation*
from the shared forward annotation, shaped so the eventual mechanical auto-deriver
(Voigtländer-style) is a refactor behind the same law — never an unwind. **No operator may
introduce a backward rule that auto-derivation could not later reproduce.** If a rule
cannot be phrased as "read the forward FD/EC/domain facts, invert," it does not belong here.

## Surface added to `PhysicalProperties`

In `planner/nodes/plan-node.ts`, add to `interface PhysicalProperties` (around the
existing `fds` / key fields — match the existing optional-readonly convention and the
`AttributeId` keying used by sibling per-attribute maps):

```typescript
/** Per-output-attribute backward update provenance (the derived dual of `fds`). */
readonly updateLineage?: ReadonlyMap<AttributeId, UpdateSite>;
/** Per-attribute insert-default provenance (constant-FD / base-default / tag). */
readonly attributeDefaults?: ReadonlyMap<AttributeId, AttributeDefault>;
```

```typescript
export type UpdateSite =
	// traces to a base-table column through a chain of invertible transforms.
	| {
			readonly kind: 'base';
			readonly table: number;            // TableReferenceNode tableId / relation id
			readonly baseColumn: string;
			// the inverse to apply to a written value before binding the base column;
			// identity when the projection is a bare/rename column ref.
			readonly inverse?: (written: AST.Expression) => AST.Expression;
			// domain restriction conjoined into the row-identifying predicate (from an
			// `inverse` profile's `domain`), if any.
			readonly domain?: AST.Expression;
		}
	// output of a non-invertible expression over inputs; read-only.
	| { readonly kind: 'computed'; readonly expr: AST.Expression }
	// potentially null-extended by an outer join; write requires materialization.
	| { readonly kind: 'null-extended'; readonly guard: AST.Expression; readonly inner: UpdateSite };

export interface AttributeDefault {
	readonly kind: 'constant-fd' | 'base-default' | 'tag-default';
	readonly value: AST.Expression;          // symbolic — may be literal, param, or context binding
}
```

`UpdateSite` is the plan-node-threaded generalization of the existing
`ViewColumnLineage` in `analysis/update-lineage.ts` (`base` / `computed`), extended
with the invertible-transform chain, the outer-join `null-extended` case, and a
machine-readable base reference (id, not name only). `analysis/update-lineage.ts`'s
`deriveViewColumns` becomes a thin reader over `updateLineage` for the single-source
case (it must continue to produce the same `ViewColumn[]` the Phase-1 surface returns,
so the orchestrator and any current callers see no behavior change — verify against the
existing `bx-roundtrip-law-harness` lineage-agreement check).

## Backward methods (the derived dual, per operator)

Thread a backward computation in each operator's `computePhysical` (or a sibling pass
invoked alongside it in the physical-property phase — match how forward `fds` are
attached today). Each reads the node's own forward `physical.fds` + children's
`updateLineage`:

- **TableReferenceNode** (`nodes/reference.ts`): seed `updateLineage` — every output
  attribute → `{ kind: 'base', table: <this tableId>, baseColumn }`. Seed
  `attributeDefaults` from declared column defaults (`kind: 'base-default'`) and
  generated columns → mark their `UpdateSite` `computed` (generated columns are
  read-only at every level).
- **ProjectNode** (`nodes/project-node.ts`): for each projection, classify via
  `classifyInvertibility(scalarPlanNode)` (the planned-node classifier in
  `analysis/scalar-invertibility.ts`, sibling to the AST-level `classifyProjectionExpr`;
  widen it past the Phase-1 identity-only stub — see scalar-invertibility note below). `passthrough`/`inverse` → thread the child's
  `UpdateSite` for the referenced attribute, composing the `inverse` fn and conjoining
  `domain`; `opaque` or any non-column non-invertible → `{ kind: 'computed', expr }`.
  Keys thread along the FDs the forward pass emitted. Carry `attributeDefaults` forward
  for surviving columns; columns projected away but determined by an FD need no default
  (same mechanism).
- **FilterNode** (`nodes/filter-node.ts`): pass child `updateLineage` through unchanged.
  For each constant FD `∅ → c = v` on the node's forward `physical.fds`, add/strengthen
  `attributeDefaults[c] = { kind: 'constant-fd', value: v }`. This REPLACES the AST
  `extractFilterConstants` scan in `building/view-mutation.ts` (which the orchestrator
  ticket deletes) — the defaults come from the FD facts, not a re-parse of the WHERE AST.
- **JoinNode** (`nodes/join-node.ts`, inner join only in this ticket): compose
  per-source `updateLineage` — each output attribute keeps the `UpdateSite` of its owning
  side (EC membership from the forward join FDs makes equi-join columns precise).
  For outer joins, wrap non-preserved-side sites in `{ kind: 'null-extended', guard }`
  using the join predicate as guard. (Outer-join *materialization* on write is a later
  phase; this ticket only annotates the lineage so the orchestrator can diagnose it.)

### Scalar invertibility — widen the stub

`analysis/scalar-invertibility.ts` currently has `classifyInvertibility(node)` return
`passthrough` only for a bare `ColumnReferenceNode` and `opaque` for everything else, and
the `InvertibilityProfile` `inverse` variant is the empty `{ kind: 'inverse' }` stub.
Widen both: extend `InvertibilityProfile`'s `inverse` to carry the inverse `fn` + optional
`domain` (per the docs `{ kind: 'inverse'; fn; domain? }`), and widen `classifyInvertibility`
to the profile registry the docs describe (§ Scalar Invertibility): `collate(x, _)` →
`passthrough`; constant integer add/sub → `inverse` with the arithmetic inverse;
lossless `cast` → `inverse`; lossy `cast` / string fns → `opaque`. Keep the registry
small and law-gated — only add a profile when the round-trip law (below) covers it.
Each profile is consumed by Project's backward method; do not special-case in Project.

## Predicate-honest complement (feeds the lens prover)

Expose the complement as a first-class derived object computed from the backward walk
(§ The predicate-honest complement). For a single-source projection-and-filter body it is:
the **projected-away base columns** (in the base, absent from the view image) + the
**negation-free residual of the view predicate** (σ conjuncts constraining base rows the
view never surfaces), expressed in the same FD/predicate vocabulary as the forward walk.
Place it where `3-lens-prover-and-attachment` can consume it (a `complementOf(node)` /
`viewComplement` accessor over the planned body — coordinate the exact surface with that
ticket's `ViewColumnLineage` consumption). This makes the lens prover's *Round-trip (lens
laws)* check **computed** (GetPut ⇔ `put` leaves the complement fixed; PutGet ⇔ `get ∘ put`
reproduces the written image) rather than an enumerated checklist.

## query_plan() surfacing

`query_plan().properties` must include the per-column `updateLineage` summary
(§ Diagnostics). With the `Map` serializer fixed in the prereq ticket, the
`updateLineage` / `attributeDefaults` maps render as bounded `$map` summaries in the
physical block — confirm EXPLAIN/`query_plan()` shows them and regenerate any goldens
that legitimately gain the new fields (this is where the real lineage diff lands, kept
clean by the serialization ticket).

## Round-trip law — static lineage-agreement extension

Extend the `bx-roundtrip-law-harness` block in `test/property.spec.ts` (do not fork it):
add **forward/backward lineage agreement** coverage over *planned* bodies for every
operator this ticket threads, **including inner join** (lineage agreement is static — it
plans the body and cross-checks `updateLineage` against `keysOf`/`fds`; it needs no
mutation execution, so join lineage can be gated here even before multi-source propagation
exists). For each output column: every `base`-writable column has a forward FD path to that
base column, and every key the forward walk advertises is reconstructible by the backward
identifying predicate. A disagreement reds the test. Keep the existing negative-self-test
structure (mutate a backward rule → law reds).

The **dynamic** PutGet/GetPut multi-source coverage (needs propagation + execution) is
explicitly deferred to `view-mutation-substrate-orchestrator`; this ticket's join coverage
is lineage-agreement only.

## Acceptance

- `updateLineage` / `attributeDefaults` populated by TableReference / Project / Filter /
  Join backward methods, each reading the forward `physical.fds` (no parallel re-derivation).
- `classifyScalarInvertibility` widened to the small law-gated profile registry.
- `deriveViewColumns` still returns identical `ViewColumn[]` for single-source bodies
  (no behavior change for current callers).
- `query_plan()` surfaces per-column lineage; goldens regenerated and explained.
- Complement object exposed for `3-lens-prover-and-attachment`.
- `bx-roundtrip-law-harness` extended with static lineage-agreement over planned bodies
  incl. inner join; negative-self-test still reds on a mutated rule.
- `yarn workspace @quereus/quereus test` + lint green.

## TODO

- [ ] Add `UpdateSite` / `AttributeDefault` types + `updateLineage` / `attributeDefaults`
      to `PhysicalProperties`.
- [ ] TableReference backward seed (base lineage, base/generated defaults).
- [ ] Project backward method via widened `classifyInvertibility`; thread keys/defaults.
- [ ] Filter backward method: constant-FD defaults from forward `fds` (not AST re-scan).
- [ ] Join (inner) backward composition along forward join FDs; outer → `null-extended` annotation.
- [ ] Widen `InvertibilityProfile.inverse` (+`fn`/`domain`) and `classifyInvertibility` to the
      law-gated profile registry.
- [ ] Re-express `deriveViewColumns` as a reader over `updateLineage`; assert parity.
- [ ] Expose `complementOf` / `viewComplement` for the lens prover.
- [ ] Surface lineage in `query_plan()`; regenerate + explain goldens.
- [ ] Extend `bx-roundtrip-law-harness` with static lineage-agreement (incl. join); keep
      negative-self-test.
- [ ] `yarn workspace @quereus/quereus test` + lint green.
