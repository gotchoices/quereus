description: Wave 1 of the inclusion-dependency (IND) property rollout — add a first-class `InclusionDependency` member to the `PhysicalProperties` dependency family (beside `fds`/`equivClasses`/`constantBindings`/`domainConstraints`), seed it from declared FKs at `TableReferenceNode`, propagate it through joins/projections with conservative drops, and prove it sound with a property/law harness. NO consumer migration in this wave — nothing user-visible changes; the prover/lens consume it in later waves. Design source: the `optimizer-inclusion-dependency-property` design spike (decomposed into this implement wave; full design carried inline below).
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, docs/optimizer.md
----

## Goal

INDs (`child.cols ⊆ target.targetCols`) currently live only as on-demand,
FK-declaration-bound helpers in `util/ind-utils.ts` (`lookupCoveringFK`,
`isRowPreservingPathToTable`). They are not a *propagated* property: existence is
never threaded through joins/projections the way uniqueness is via `fds`. This
wave makes IND a first-class propagated member of the `PhysicalProperties`
dependency family, mirroring the proven `fds` / `constantBindings` /
`domainConstraints` foundation pattern.

This is purely additive plumbing + a soundness harness. **No consumer reads the
new property in this wave** — `ind-utils.ts` and the three IND rules
(`rule-anti-join-fk-empty`, `rule-semi-join-fk-trivial`,
`rule-join-elimination`) stay untouched (they need the FK *declaration* —
nullability split + positional composite pairing — that a coarse `child ⊆ parent`
fact does not carry). The new property is a *parallel derivation surface*. Wave 2
(`coverage-prover-ind-derived-no-row-loss`) is the first consumer; Wave 3 is the
lens injection (`lens-multi-source-decomposition`).

## The abstraction

New types in `plan-node.ts`, beside `FunctionalDependency`:

```typescript
export interface InclusionDependency {
  // Output-column indices on THIS relation whose tuple is guaranteed to exist in `target`.
  readonly cols: readonly number[];
  readonly target: IndTarget;
  // true: a NULL in any of `cols` excludes that row from the guarantee (MATCH SIMPLE / nullable FK).
  // false: total — every row's `cols` tuple is present in the target.
  readonly nullRejecting: boolean;
}

export type IndTarget =
  // child.cols ⊆ table.targetCols, where targetCols is a key of that table. The FK-seeded form.
  | { readonly kind: 'table'; readonly schema: string; readonly table: string; readonly targetCols: readonly number[] }
  // For lens-decomposition anchors: a basis relation addressed by a stable symbolic id the lens compiler mints.
  | { readonly kind: 'relation'; readonly relationId: string; readonly targetCols: readonly number[] };
```

`PhysicalProperties` gains `inds?: ReadonlyArray<InclusionDependency>`. Document it
in the same comment style as the sibling `fds` / `constantBindings` /
`domainConstraints` members, noting it asserts *existence* of a tuple in another
relation (strictly weaker than, and orthogonal to, an FD's *determination* within
this relation). `kind:'table'` is the FK-seeded case the prover reasons over;
`kind:'relation'` is reserved for the Wave-3 lens existence-anchor injection (no
producer mints it in this wave — include the variant in the type so the surface is
enforcement-ready, but only `kind:'table'` is exercised here). The
obligation-vs-discharge enforcement-readiness rationale (why this surface can
later carry a runtime enforcement consumer without raising the propagation bar)
is captured in the § Soundness boundary note below and belongs in the
`docs/optimizer.md` subsection this wave adds.

## Soundness boundary (load-bearing)

A false IND (**over-claim**) is unsound — it asserts a row exists that does not,
which would silently mis-prove coverage downstream (and, once an enforcement
consumer rides this surface, wrongly discharge an obligation ⇒ skip a needed
check). A missing IND (**under-claim**) only forgoes an optimization/discharge
(the fallback path runs — safe). Therefore **every propagation rule is
conservative: drop when unsure.** This matches the coverage prover's existing
"a false `Covers` is unsound ⇒ be conservative" bar and the RI-trust assumption
`ind-utils.ts` already makes (declared FKs treated as hard inclusion
dependencies; `pragma foreign_keys` defaults on). Admitting a future enforcement
consumer does **not** raise this bar, because enforcement obligations come from
the authoritative FK/lens *declaration*, never from the propagated set (see the
spike's § Enforcement readiness).

## Per-operator / per-property surface

New helpers in `fd-utils.ts`, named to match the family and sitting beside
`projectFds` / `shiftFds` / `mergeFds` / `addFd`:

- `projectInds(inds, mapping)` — drop an IND when **any** of its `cols` loses its
  mapping (the relation no longer carries the witnessing columns); remap survivors
  to output indices. Note the asymmetry vs `projectFds`: an IND's `cols` is
  **all-or-nothing** — there is no partial-dependent survival. `target.targetCols`
  are indices in the *target* relation, NOT this relation's output, so they are
  **not** remapped by the mapping.
- `shiftInds(inds, offset)` — shift each IND's `cols` by `offset` (mirrors
  `shiftFds`). `target.targetCols` are target-relative ⇒ **not** shifted.
- `mergeInds(a, b)` — concat + structural-dedup (mirror `mergeFds`/
  `mergeDomainConstraints`), capped at `MAX_INDS_PER_NODE`.
- `addInd(inds, next, opts?)` — single-add with structural dedup + cap.
- `MAX_INDS_PER_NODE = 64` (mirror `MAX_FDS_PER_NODE`); log truncations under the
  existing `quereus:planner:fd` logger like the FD/binding/domain caps do.

Structural equality for dedup compares `cols` (as a set/ordered list — match the
`fdsEqual` convention), `nullRejecting`, and `target` (kind + schema/table or
relationId + targetCols).

### Seeding — `TableReferenceNode.computePhysical` (`reference.ts`)

Beside the existing FD/CHECK seeding, seed **one IND per declared FK whose
referenced columns form a key of the parent**:
- `cols` = the FK child columns' output indices (here, base-table column indices,
  since `TableReferenceNode` output = table columns 1:1).
- `target` = `{ kind: 'table', schema: parent.schemaName, table: parent.name,
  targetCols: parent-key-column-indices }`.
- `nullRejecting` = **(any FK child column nullable)** — the *same* nullability
  bit `lookupCoveringFK` computes as `CoveringFKMatch.nullable`.

**Factor the nullability bit into one shared helper** so the seeded property and
the rule helper cannot diverge. `lookupCoveringFK` (ind-utils.ts) currently
computes `nullable` inline; extract a tiny `fkChildNullable(childSchema, fk):
boolean` (recommended home: `ind-utils.ts`, the canonical FK-nullability site)
and have **both** `lookupCoveringFK` and the seeding call it. This is the only
edit to `ind-utils.ts` and is purely additive — no behavior change to
`lookupCoveringFK`. Reuse the existing referenced-column → key check the FK
machinery already performs (mirror how `lookupCoveringFK` validates that every
`referencedColumns[i]` is a PK column) so a malformed FK referencing non-PK
columns never seeds an IND.

### Join propagation — new `propagateJoinInds` in `join-utils.ts`

Mirror `propagateJoinFds`: a single function taking `(joinType, leftPhys,
rightPhys, leftColumnCount)` returning `inds?`. Call it from
`JoinNode.computePhysical` (`join-node.ts`) alongside `propagateJoinFds`, and from
`BloomJoinNode` / `MergeJoinNode` `computePhysical`. Branch table — the IND
analogue of `propagateJoinFds`, and it MUST stay consistent with it and
`analyzeJoinKeyCoverage`:

- `inner` / `cross`: union of `leftInds` and `shiftInds(rightInds,
  leftColumnCount)`.
- `left` (preserved = left): keep `leftInds`; **drop** the null-padded right
  side's INDs (NULL-padding can only hit the right side, never the preserved
  left side's `cols`).
- `right` (preserved = right): keep `shiftInds(rightInds, leftColumnCount)`; drop
  left.
- `semi` / `anti`: keep `leftInds` only (right columns are not in the output).
- `full`: **drop both** (either side can be NULL-padded).

### Projection — `projectInds` in `ProjectNode` and `ReturningNode`

Both nodes already project `fds`/`equivClasses`/`bindings`/`domains` through the
column `map`. Add `projectInds(sourcePhysical?.inds ?? [], map)` and surface it as
`inds: result.length > 0 ? result : undefined` in the returned partial.

### Pass-through nodes — propagate unchanged

Row-removal preserves a per-row inclusion claim, so these inherit INDs verbatim
(add `inds: childPhysical.inds` wherever they already pass `fds` through):
`FilterNode` (`filter.ts`), `AliasNode` (`alias-node.ts`), `SortNode`
(`sort.ts`), `DistinctNode` (`distinct-node.ts`), and the physical scan nodes in
`table-access-nodes.ts` (SeqScan/IndexScan — a *full* scan preserves the claim;
note for the consumer's benefit that a row-reducing seek still preserves a
per-row claim, so pass-through is safe even there). Use the existing `fds:` lines
in each node's `computePhysical` (the 22 producers grep'd in
`src/planner/nodes/`) as the discovery list — wherever a node deliberately passes
`fds` straight through, pass `inds` the same way.

### Identity-reshaping nodes — drop conservatively

`AggregateNode`, `SetOperationNode`, `WindowNode` reshape relational identity ⇒ do
NOT emit `inds` (leave undefined). `AsyncGatherNode` crossProduct *could*
shift+merge INDs like it does FDs, but that is **out of scope for this wave**
(no consumer); leave it undefined and note the deferral in a comment.

## Docs

Extend `docs/optimizer.md` § "Functional Dependency Tracking" (line ~1306) with a
sibling "Inclusion Dependency Tracking" subsection: the property shape, the
seeding source, the per-operator propagation table above, and the
over-claim-unsound / under-claim-safe boundary. Cross-link the existing
"Inclusion-dependency reasoning" section (~1605, the `ind-utils.ts` helper/rules)
and state explicitly that the propagated property is a *parallel derivation
surface*, not a migration of those helpers.

## Key tests (this wave)

Add an optimizer spec (e.g. `test/optimizer/inclusion-dependencies.spec.ts`) plus
unit tests on the new helpers (style: `test/optimizer/conditional-fds.spec.ts`,
which already unit-tests `projectFds`/`shiftFds`/`addFd`):

- **Unit — helpers.** `projectInds` drops on lost `cols` (all-or-nothing), remaps
  survivors, and does NOT remap `target.targetCols`; `shiftInds` shifts `cols`
  only; `mergeInds`/`addInd` dedup structurally and honor the cap;
  `nullRejecting` is preserved through project/shift.
- **Seeding.** A composite NOT-NULL FK seeds one *total* IND (`nullRejecting:
  false`); a nullable FK seeds a `nullRejecting: true` IND; an FK referencing
  non-PK columns seeds none.
- **Join propagation.** inner = union; LEFT keeps preserved-side IND and drops the
  null-padded side's IND; RIGHT symmetric; full drops both; semi/anti keep left.
- **Property/law harness (the load-bearing safety check — the IND analogue of the
  `keysOf`/`isUnique` soundness harness from `unified-key-inference-surface`).**
  For representative optimized plans, materialize each relational node and assert
  the propagated INDs never **over-claim**: for each IND, every materialized row's
  `cols` projection (excluding NULL-rejected rows when `nullRejecting`) actually
  appears in the target relation's `targetCols` projection. This is the bar that
  makes Wave-2 prover consumption sound.

## TODO

### Phase 1 — property + helpers
- Add `InclusionDependency` / `IndTarget` types and `PhysicalProperties.inds` in `plan-node.ts` with sibling-style docs.
- Add `projectInds` / `shiftInds` / `mergeInds` / `addInd` + `MAX_INDS_PER_NODE` to `fd-utils.ts` with structural dedup + cap-logging.
- Unit tests for the four helpers (drop-on-lost-col all-or-nothing, no target remap/shift, dedup, cap, nullRejecting preservation).

### Phase 2 — seeding
- Extract `fkChildNullable` into `ind-utils.ts`; route `lookupCoveringFK`'s `nullable` through it (no behavior change).
- Seed FK INDs in `TableReferenceNode.computePhysical` (`reference.ts`), reusing the referenced-cols-form-a-key check.
- Seeding tests (composite NOT-NULL → total; nullable → nullRejecting; non-PK ref → none).

### Phase 3 — propagation
- Add `propagateJoinInds` to `join-utils.ts`; wire into `JoinNode` / `BloomJoinNode` / `MergeJoinNode` `computePhysical`.
- Add `projectInds` to `ProjectNode` and `ReturningNode` `computePhysical`.
- Pass `inds` through Filter / Alias / Sort / Distinct / physical scans (mirror their existing `fds:` pass-through).
- Confirm Aggregate / SetOperation / Window emit no `inds`; leave AsyncGather IND-merge deferred with a comment.
- Join-propagation tests (inner/left/right/full/semi/anti branch table).

### Phase 4 — harness + docs
- Property/law harness asserting no IND over-claims on materialized optimized plans.
- Extend `docs/optimizer.md` with the "Inclusion Dependency Tracking" subsection.
- Run `yarn workspace @quereus/quereus run build`, the optimizer specs, and lint; confirm no golden-plan churn (no consumer reads `inds` this wave, so plans must be byte-identical).
