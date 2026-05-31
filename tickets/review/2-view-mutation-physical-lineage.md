description: Review the plan-node-threaded backward update-lineage **annotation layer** — `updateLineage` / `attributeDefaults` on `PhysicalProperties`, threaded as the derived dual of the forward FD walk by TableReference / Project / Filter / Join (+ pass-through on access / Retrieve / Alias boundary nodes), the widened law-gated scalar-invertibility registry, the `viewComplement` accessor, and the static forward/backward lineage-agreement property coverage (incl. inner join). No propagation/execution path — the orchestrator (`view-mutation-substrate-orchestrator`) consumes this surface.
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts (UpdateSite/AttributeDefault types + the two PhysicalProperties fields), packages/quereus/src/planner/analysis/scalar-invertibility.ts (widened InvertibilityProfile.inverse + classifyInvertibility + traceInvertibleColumn), packages/quereus/src/planner/analysis/update-lineage.ts (deriveProjectUpdateLineage / deriveFilterAttributeDefaults / deriveJoinUpdateLineage / viewColumnsFromUpdateLineage / identityBaseColumn), packages/quereus/src/planner/analysis/view-complement.ts (NEW — viewComplement / complementOf), packages/quereus/src/planner/nodes/reference.ts (TableReference seed), packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts + retrieve-node.ts + alias-node.ts (boundary pass-through), packages/quereus/test/property.spec.ts (Law 4 + parity + complement), packages/quereus/test/plan/{basic/simple-select,joins/simple-join,aggregates/group-by}.plan.json (regenerated goldens), docs/view-updateability.md
----

## What this ticket delivered (the annotation layer)

The backward update surface threaded onto `PhysicalProperties` as the **derived
dual** of each operator's forward FD walk — `bx`-discipline-compliant: **one** FD
annotation per node (the forward `physical.fds` the operator already emits); the
backward method *reads* it, never re-derives a parallel walk. No new
propagation/execution path — this is purely the annotation layer the
`view-mutation-substrate-orchestrator` will walk.

### Surface added

- `plan-node.ts` — `UpdateSite` (`base` / `computed` / `null-extended`) and
  `AttributeDefault` types; `updateLineage?: ReadonlyMap<AttributeId, UpdateSite>`
  and `attributeDefaults?: ReadonlyMap<AttributeId, AttributeDefault>` on
  `PhysicalProperties` (keyed by `Attribute.id`, matching sibling per-attribute maps).
- **TableReference** (`reference.ts`) — seeds `base` lineage (each output attr →
  its base column, `table` = the node's numeric plan-node id), generated columns →
  `computed`, declared defaults → `attributeDefaults{base-default}`.
- **Project** (`project-node.ts` → `deriveProjectUpdateLineage`) — traces each
  projection to a base column through the invertible-transform chain
  (`traceInvertibleColumn`), composing the inverse + domain onto the child's
  `UpdateSite`; non-invertible / multi-column / literal projections → `computed`;
  carries defaults for surviving columns.
- **Filter** (`filter.ts` → `deriveFilterAttributeDefaults`) — passes
  `updateLineage` through unchanged; adds a `constant-fd` default for every column
  the forward pass pinned constant, **read off the node's `constantBindings`**, not
  a re-scan of the predicate AST (this replaces `building/view-mutation.ts`'s
  `extractFilterConstants`, which the orchestrator deletes).
- **Join** (`join-node.ts` → `deriveJoinUpdateLineage`) — merges per-side lineage
  (attribute ids are preserved per side); outer joins wrap the non-preserved side
  `null-extended` under the join predicate (annotation only).
- **Scalar invertibility** (`scalar-invertibility.ts`) — widened
  `InvertibilityProfile.inverse` to carry `fn` + optional `domain`; widened
  `classifyInvertibility` to the law-gated registry (`collate` → passthrough; no-op
  `cast` → passthrough; constant-integer `±` → `inverse`; everything else opaque);
  added the recursive `traceInvertibleColumn` that composes the inverse chain.
- **Complement** (`view-complement.ts`, NEW) — `viewComplement(node)` /
  `complementOf`: the projected-away base columns + the σ residual, derived off the
  backward walk, for the lens prover's computed round-trip check.
- **query_plan() surfacing** — `updateLineage` / `attributeDefaults` render as
  bounded `$map` summaries via the prereq serializer; the three plan goldens were
  regenerated (`UPDATE_PLANS=true`).

## Validation (what was run — green)

- `yarn workspace @quereus/quereus test` → **4103 passing, 0 failing, 9 pending**.
- `yarn workspace @quereus/quereus run lint` → clean. `typecheck` → clean.
- Golden plan tests re-run **without** `UPDATE_PLANS` → byte-identical (the `table`
  ids are stable under the harness's `withDeterministicPlanIds` reset).

### Use cases the reviewer should exercise / push on

- **Static lineage agreement** (`property.spec.ts` § View Round-Trip Laws, the new
  "forward/backward plan lineage agreement … (incl. inner join)" `it`): plans the
  single-source zoo **and** a key-preserving FK-style inner join off the **logical**
  plan (`db._buildPlan`), and cross-checks `physical.updateLineage` against
  `keysOf` — every forward-key column must be base-writable; every output column
  must carry a lineage entry. Negative self-test (`the plan-lineage law core fails
  loudly on injected violations`) reds the core on a computed key column / a missing
  entry. **Push:** widen the join zoo (multi-row right side, self-join, 3-way),
  add outer-join shapes (the `null-extended` path is threaded but only smoke-checked).
- **deriveViewColumns ⇄ updateLineage parity** (`viewColumnsFromUpdateLineage agrees
  with deriveViewColumns on the writable set`): the plan-node reader and the shipped
  AST classifier agree on the writable-base-column set across the zoo (identity-base
  ⇔ writable; `b+1` / computed ⇔ read-only). **Push:** a body with a generated
  column (the zoo has none — see gap below).
- **Complement** (`viewComplement exposes the projected-away base columns and the σ
  residual`): one drop-`b`-filter-on-`a` case + an empty `select *` case. **Push:**
  multi-source complement, residual normalization (negation-free claim is asserted
  by construction, not tested against a `NOT`-bearing predicate).

## Known gaps / deliberate deviations (treat tests as a floor)

1. **`deriveViewColumns` was NOT replaced in place.** The TODO said "re-express
   `deriveViewColumns` as a reader over `updateLineage`." Instead I **kept** the AST
   `deriveViewColumns` (so current callers — `building/view-mutation.ts` — see zero
   behavior change, per acceptance) and **added** the reader
   `viewColumnsFromUpdateLineage` + a parity test. Rationale: a literal in-place
   replacement needs a *planned node* at every call site, which the AST-only callers
   don't have; the orchestrator ticket explicitly migrates those call sites to the
   planned body and deletes the AST path. Replumbing now would risk the shipped
   Phase-1 path for code the next ticket removes. **The reader cannot be perfectly
   lossless** (a `base`+inverse or generated site can't round-trip to the exact
   Phase-1 `ViewColumn.expr` / `generated` flag), so the parity check compares the
   **writable set** (kind / name / baseColumnName), which is the load-bearing
   invariant. Reviewer: confirm this is an acceptable reading of the TODO.

2. **`updateLineage` survives optimization only through pass-through boundary
   nodes** (access scans, Retrieve, Alias, Filter, Project). It is **dropped** by
   structure-rewriting operators — physical `HashJoin` / `MergeJoin`, aggregates,
   set-ops, Sort/Limit/Distinct — which do not thread it. So on the *optimized*
   plan, a join's top Project shows degraded (`computed`) lineage (visible in the
   regenerated `simple-join` golden, lines ~725). The **logical** operator tree is
   authoritative and is what the orchestrator/harness walk; this is documented in
   `docs/view-updateability.md` § Surface authority. Reviewer: decide whether
   `query_plan()` on optimized join plans needs full lineage now (would require
   threading the physical joins) or stays deferred to the orchestrator.

3. **Invertibility registry is intentionally minimal.** "Lossless cast → inverse"
   is realized as **no-op cast** (same logical type) → `passthrough` — the only
   cast we can prove value-preserving (mirrors `CastNode.isInjectiveIn`'s
   conservative rule); genuine widening casts stay `opaque`. Only constant-**integer**
   `±` is `inverse` (constant operand must be a `LiteralNode` integer; the column
   operand must be numeric). No `coalesce` / string profiles. Each profile is covered
   by the round-trip law; adding more is the law-gated extension path.

4. **`inverse` is a closure → not serialized** in `query_plan()` (JSON drops
   functions); the `$map` shows `kind` / `table` / `baseColumn` / `domain` only. By
   design — diagnostics don't need the function body. (Verified: 0 `"inverse"` keys
   in the goldens.)

5. **`null-extended` (outer-join) lineage** is threaded and unit-shaped but only
   smoke-covered; there is no outer-join lineage-agreement or dynamic test. The
   dynamic PutGet/GetPut multi-source gate (incl. outer-join materialization) is
   explicitly the orchestrator's job.

6. **Join `attributeDefaults` merge** is the simple union of contributing sides —
   adequate for the annotation layer; insert-default precedence across join sides is
   the orchestrator's concern.

## Acceptance check

- [x] `updateLineage` / `attributeDefaults` populated by the four backward methods,
      reading the forward annotation (no parallel re-derivation).
- [x] `classifyInvertibility` widened to the law-gated registry.
- [x] `deriveViewColumns` returns identical `ViewColumn[]` (unchanged) — parity
      asserted via `viewColumnsFromUpdateLineage` (see deviation #1).
- [x] `query_plan()` surfaces per-column lineage; goldens regenerated + explained.
- [x] Complement object exposed (`view-complement.ts`).
- [x] `bx-roundtrip-law-harness` extended with static lineage-agreement incl. inner
      join; plan-lineage negative-self-test reds on a mutated rule.
- [x] `yarn workspace @quereus/quereus test` + lint green.

## Downstream

`view-mutation-substrate-orchestrator` (implement/, `prereq: view-mutation-physical-lineage`)
walks this `updateLineage` / `attributeDefaults` surface to emit `BaseOp[]`, adds the
dynamic multi-source PutGet/GetPut gate, and retires `building/view-mutation.ts`
(deleting the AST `extractFilterConstants` this ticket's Filter defaults replace).
The lens prover (`schema/lens-prover.ts`, `proveRoundTrip` seam) is the
`viewComplement` consumer.
