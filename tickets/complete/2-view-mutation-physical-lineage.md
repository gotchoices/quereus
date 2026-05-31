description: COMPLETE — the plan-node-threaded backward update-lineage annotation layer (`updateLineage` / `attributeDefaults` on `PhysicalProperties`, the widened scalar-invertibility registry, the `viewComplement` accessor, and static forward/backward lineage-agreement coverage). Reviewed adversarially; two test gaps and one doc overstatement fixed inline; no major findings. Downstream `view-mutation-substrate-orchestrator` consumes this surface.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/{table-access-nodes,retrieve-node,alias-node}.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

# View-mutation physical lineage — the backward annotation layer (COMPLETE)

The derived dual of each operator's forward FD walk, threaded onto
`PhysicalProperties.updateLineage` / `attributeDefaults`: a `base` / `computed` /
`null-extended` `UpdateSite` per output attribute, plus per-attribute insert
defaults. Seeded at `TableReferenceNode`, threaded by Project / Filter / Join,
passed through the access / Retrieve / Alias boundary nodes. Backed by the
law-gated `classifyInvertibility` / `traceInvertibleColumn` registry (identity /
rename / `collate` / no-op `cast` → passthrough; constant-integer `±` → inverse;
everything else opaque) and the predicate-honest `viewComplement` accessor.

The orchestrator (`view-mutation-substrate-orchestrator`, implement/) walks this
surface to emit `BaseOp[]`; the lens prover rides `viewComplement`. No
propagation/execution path lands here — this is purely the annotation layer.

See the implement-stage handoff (git `ticket(implement): view-mutation-physical-lineage`,
commit `85b92872`) for the full surface inventory and the author's declared gaps.

## Review findings

**Scope reviewed.** Read the full implement diff with fresh eyes (plan-node
types, the four backward methods, the invertibility registry, `view-complement`,
all node threading, the three regenerated plan goldens, the doc edits, the new
property tests). Verified every load-bearing accessor/assumption against the
actual codebase; ran lint + typecheck + the full test suite.

### Correctness — checked, no defects found

- **Join merge-by-attribute-id** (`deriveJoinUpdateLineage`). The claim "output
  attribute ids are preserved per side, so the maps merge directly" is *true*:
  `join-utils.buildJoinAttributes` carries left/right input `Attribute` objects
  (and their ids) into the output unchanged (nullable-remarked only). Left/right
  id sets are disjoint, so the lineage **and** the default union are
  collision-free. Outer-side null-extension wiring (`left`→right wrapped,
  `right`→left wrapped, `full`→both, `semi`/`anti`→left-only) is correct.
- **Inverse composition order** (`composeUpdateSite` / `traceInvertibleColumn`).
  For `out = f(child)` with `child = g⁻¹(base)`, a written `out` binds
  `base = g⁻¹(f⁻¹(out))` — inner inverse wraps the outer. Verified by reasoning
  and by the new chain test (`(b+1)+2` → `(w−2)−1`).
- **`isNoOpCast` reference-equality** (`logicalType === logicalType`) exactly
  mirrors the already-shipped, accepted `CastNode.isInjectiveIn` rule; registry
  singletons make a false-positive impossible and a false-negative merely
  conservative (column → read-only). Safe.
- **`ConstantBinding.attrs` are positional output column indices** (per the type
  doc), so `deriveFilterAttributeDefaults`'s `outputAttrs[colIdx]` lookup is
  correct.
- **`Number(this.id)`** — `PlanNode.id` is a numeric string (`${nextId++}`), so
  the `UpdateSite.table` discriminator is a clean number; consistent between the
  TableReference seed and `viewComplement`.
- **Accessors** (`ScalarPlanNode.expression`, `ColumnReferenceNode.attributeId`,
  `BinaryOpNode.left/right`, `CastNode.operand`, `CollateNode.operand`,
  `LiteralNode.expression.value`, optional `logicalType.isNumeric`) all confirmed;
  the `isNumeric` optionality yields conservative (non-numeric → opaque) behavior.
- **Boundary pass-through** (SeqScan / IndexScan / IndexSeek / Retrieve / Alias /
  Filter) threads `updateLineage` + `attributeDefaults` unchanged — verified each
  `computePhysical`.

### Minor findings — FIXED IN THIS PASS

1. **Test gap: the widened invertibility registry had ZERO behavioral coverage.**
   The static lineage-agreement law only constrains *key* columns, and the
   `viewColumnsFromUpdateLineage` parity reader collapses `base`-with-inverse to
   `computed` — so neither test ever exercised `classifyInvertibility` /
   `traceInvertibleColumn` for `±k`, no-op cast, collate, chain composition, or the
   opaque fallbacks. No test in the repo referenced those symbols. **Added** a
   focused test (`property.spec.ts` § View Round-Trip Laws, *"invertibility
   registry composes inverses for ±k / no-op cast / collate, opaque otherwise"*)
   that reads the planned `UpdateSite` directly and asserts: `b+1`→`w−1`, `b−5`→`w+5`,
   `10−b`→`10−w`, `(b+1)+2`→`(w−2)−1`, no-op cast / collate → identity base,
   and `a+b` / `b*2` / `b+1.5` → `computed`.

2. **Test gap: the entire `attributeDefaults` surface was untested.** No test
   touched `attributeDefaults`, `base-default`, or `constant-fd`. **Added**
   *"attributeDefaults seeds base-default and constant-fd provenance"*: `where a=2`
   → `constant-fd` value 2 surviving the projection; no filter → no default; a
   declared `default 7` column → `base-default` at the table reference.

3. **Doc overstatement.** `view-complement.ts` described `residualPredicate` as
   the *"negation-free residual"*, but the code conjoins raw `FilterNode`
   predicates with no normalization (the author's own gap list flagged this).
   **Tightened** the comment to state it is the verbatim σ conjunction —
   negation-free only within the supported conjunctive-σ envelope, carried as-is
   for out-of-envelope `not`/`<>`.

4. **Contract clarification (code comment).** Added a `NOTE for the consumer` to
   `AttributeDefault` (`plan-node.ts`): `value` is in the **base** column's domain,
   so for a transformed (`base`+`inverse`) site an omitted-column insert sets the
   base column to `value` directly (the inverse is bypassed — there is no written
   view value to invert). This removes the ambiguity around a `constant-fd` /
   `base-default` carried onto a transformed output column; the orchestrator owns
   precedence. (Behavior unchanged — comment only.)

### Observations — confirmed acceptable, no action (orchestrator's concern)

- **Deviation #1 (kept AST `deriveViewColumns`, added the reader).** Confirmed an
  acceptable reading of the TODO: the AST-only call sites (`building/view-mutation.ts`)
  genuinely have no planned node, the orchestrator migrates them, and the parity
  test validates the load-bearing invariant (the *writable* base-column set). The
  reader is deliberately lossy (inverse-writable → reported `computed`); fine for
  the Phase-1 writable contract.
- **Deviation #2 (optimized join shows degraded `computed` lineage).** The logical
  operator tree is authoritative and is what the orchestrator/harness walk;
  documented in `docs/view-updateability.md` § Surface authority. Threading the
  physical `HashJoin`/`MergeJoin` is the orchestrator's call if EXPLAIN ever needs
  full lineage on optimized join plans. No ticket.
- **`viewComplement` envelope.** `collect` walks the whole subtree (would pick up
  predicate-subquery table refs, and trusts the top node's lineage); correct within
  the documented single-source / projection-filter / inner-join envelope. No action.

### Validation (re-run green after the review edits)

- `yarn workspace @quereus/quereus test` → **4105 passing** (4103 + 2 new), 0
  failing, 9 pending.
- `yarn workspace @quereus/quereus run lint` → clean. `typecheck` → clean.
- Plan goldens unchanged (no source-behavior change; edits were tests + comments).

### Major findings

**None.** No new fix/plan/backlog ticket spawned. The deferred dynamic
multi-source PutGet/GetPut gate, outer-join lineage agreement, and default
precedence are already owned by the existing `view-mutation-substrate-orchestrator`
(implement/, `prereq: view-mutation-physical-lineage`).
