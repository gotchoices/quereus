description: Implement view updateability per the timeless design in `docs/view-updateability.md`. Today views are **read-only by design** — `insert/update/delete` against a view name errors at the table-resolution boundary (confirmed by `test/logic/93.1-view-error-paths.sqllogic`). This ticket lifts the doc into a concrete implementation plan: the `updateLineage` surface on `PlanNode`, per-attribute default inference (Dataphor-style), per-operator `propagateMutation`, the propagation dispatcher, lineage discriminator (`base` / `computed` / `null-extended`), constant-FD default recovery, branch-consistency fan-out for n-ary operators, the mutation-context envelope as a substrate, and the runtime orchestrator that issues per-base operations in order. Substrate for the lens layer and for write-through-materialized-view (both currently gated on this).
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/table.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/logic/93.1-view-error-paths.sqllogic, docs/view-updateability.md, docs/architecture.md
----

## Current state — what's actually shipped

The `docs/view-updateability.md` design is timeless prose: it describes the intended feature, not the present implementation. Per a fresh code audit (May 2026):

- **No `updateLineage` field** exists on `PlanNode` or any subtype. The doc's "Implementation Surface" reference to `src/planner/mutation/propagate.ts` points to a directory that does not exist.
- **No propagation pass.** No `propagateMutation` / `propagateInsert` / `propagateDelete` dispatcher. No per-operator method on `ProjectNode`, `FilterNode`, `JoinNode`, `SetOperationNode`, `AggregateNode` for handling writes.
- **DML against a view is rejected at table resolution.** `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` (`packages/quereus/src/planner/building/{insert,update,delete}.ts`) all call `buildTableReference(stmt.table, ...)`, which invokes `resolveTableSchema` — a function that searches `schemaManager.findTable()` and errors with "table not found" on view names. `test/logic/93.1-view-error-paths.sqllogic` § 2 (lines 23–41) explicitly asserts this.
- **Default recovery today is a base-column lookup, not an attribute property.** `insert.ts:124` reads `tableColumn.defaultValue` directly off the resolved `TableSchema`. Defaults do not survive projection; once a column is projected away the engine has no path back to its default expression except via the base-table lookup at write time.
- **`extractBindings` (the forward dual) already exists.** `packages/quereus/src/planner/analysis/binding-extractor.ts` produces FD-aware per-`TableReferenceNode` `BindingMode`s consumed by `DeltaExecutor` (assertions, `Database.watch`). The propagation pass this ticket adds is its reverse: given a mutation at the top, find the writes at the base.
- **`Statement.getChangeScope()` is FD-aware** (`packages/quereus/src/planner/analysis/change-scope.ts`) and already propagates FROM-position DML write-targets, but has no concept of view-mediated writes — a `update v ...` cannot yet exist, so the case has never been exercised.
- **`docs/architecture.md`** lists "Predicate-Driven View Updateability" under "Key Design Decisions" as if shipped. That entry is design-intent; this ticket makes it true.

This audit replaces the architecture doc as the source of truth for "what exists today."

## Scope

This ticket is a substantial implementation. It is **the prereq** for two ticketed downstream features:

- **`lens-foundation-and-default-mapper`** — `docs/lens.md` opens by saying "A lens is the bidirectional-transformation (`get`/`put`) pair that Quereus's view updateability already provides." That premise becomes true only once this ticket lands.
- **Writeable materialized views** (currently parked: `materialized-view-core` makes MVs read-only at the user-write boundary in v1). When this ticket lands, write-through-MV becomes a routing change in `materialized-view-core`'s already-retained MV body AST.

The doc enumerates the design; this ticket's job is to lock the implementation surface and decompose it into implementable phases.

## Coordination with sibling tickets

Three plan tickets currently sit at sequence 1 in `tickets/plan/`:

- `1-view-updateability-implementation.md` (this one) — no `prereq:`; root.
- `1-lens-foundation-and-default-mapper.md` — must list `prereq: view-updateability-implementation` (the lens design opens by asserting view updateability is already present). The runner will then defer it across runs until this ticket clears phase 1.
- `1-materialized-view-core.md` — needs `prereq: view-updateability-implementation` for write-through-MV. Read-only MV work itself does not require it; verify scope and add the prereq only if write-through is in this ticket's range.

The implement-stage agent for **this** ticket should set those two sibling tickets' `prereq:` headers as part of phase 1 — they're load-bearing for the runner's cross-stage gate and easy to forget.

## Design

The full design lives in `docs/view-updateability.md` — extensive, decided. This section pins down what implement-stage must produce.

### Reuse of the FD framework

The propagation pass is the **dual** of `extractBindings` (`planner/analysis/binding-extractor.ts`):

- `extractBindings` walks a plan top-down and emits, per `TableReferenceNode`, the `BindingMode` (`row` / `group` / `global`) by which base changes propagate *forward* to plan outputs.
- The view-updateability propagation pass walks the same plan and emits, per `TableReferenceNode`, the per-base operation that realizes a user mutation against the plan's outputs.

Both consume the same FD / EC / predicate-normalizer pipeline. Implementers must not fork the analysis — the per-operator FD propagation rules already encode "what determines what" in both directions. The propagation dispatcher is a new visitor; the **facts it reads** come from existing FD surfaces.

### `updateLineage` shape

```ts
type UpdateSite =
  | { kind: 'base'; baseTable: TableSchemaRef; baseColumn: number; inverse?: ScalarPlanNode }
  | { kind: 'computed'; originatingExpression: ScalarPlanNode }
  | { kind: 'null-extended'; underlying: UpdateSite };  // outer-join wrapper

interface AttributeDefault {
  /** Expression usable as a default value at insert time. Survives projection. */
  expression: ScalarPlanNode;
  /** Cadence the mutation-context envelope must apply to this expression. */
  cadence: 'literal' | 'per-statement' | 'per-row';
  /** Origin for diagnostics. */
  source:
    | { kind: 'base-column'; baseTable: TableSchemaRef; baseColumn: number }
    | { kind: 'constant-fd'; predicate: ScalarPlanNode }   // ∅ → c = v from σ
    | { kind: 'default-for-tag'; viewName: string };
}

interface RelationalPlanNode {
  // ... existing fields ...
  readonly updateLineage: ReadonlyMap<AttributeId, UpdateSite>;
  readonly attributeDefaults: ReadonlyMap<AttributeId, AttributeDefault>;
}
```

Computed in a dedicated pass (`packages/quereus/src/planner/analysis/update-lineage.ts`) that mirrors how `fds` are propagated today. Reuses attribute IDs from `attribute-provenance-surface` (already shipped). Per-operator rule examples:

- `TableReferenceNode`: every attribute is `base`-lineage, identity-inverse, `baseColumn = column index`. Every attribute with a base-column `defaultValue` originates an `AttributeDefault` with cadence inferred from determinism (`literal` for constants, `per-statement` for `now()`-class non-det, `per-row` for sequences / surrogate allocators).
- `ProjectNode`: per-attribute, depends on the projection expression's invertibility. The invertibility classifier is `packages/quereus/src/planner/analysis/scalar-invertibility.ts` (new — small, well-bounded; pure-function expressions over a single column with a known inverse form an enumerable set). **Attribute defaults pass through unchanged** on identity / column-rename projections; non-invertible projections drop the default. Projecting a column **away** does not delete the default — the propagation pass still has it via the attribute ID even though the attribute is no longer in the output (this is the Dataphor inheritance step described below).
- `FilterNode`: lineage and defaults pass through verbatim; the filter predicate contributes constant FDs (`∅ → c = v`) that surface as **synthetic `AttributeDefault` entries** with `source: { kind: 'constant-fd', ... }`. This unifies the GreenMen pattern under the same per-attribute mechanism.
- `JoinNode`: union of left + right lineage with attribute IDs preserved. `null-extended` wrapping for the non-preserved side of an outer join. Defaults union as well; an attribute participating in an EC inherits defaults from any EC member.
- `SetOperationNode`: lineage per branch; the propagation pass routes per branch. Defaults are per-branch; a branch's default applies when propagation routes to that branch.
- `AggregateNode`: grouping columns retain underlying lineage and defaults; aggregate output columns are `computed`.

### Per-attribute default inference (Dataphor-style)

Dataphor (and D4) attached default expressions to attributes and propagated them through the algebra: `A over { col1 }` retains `A`'s defaults on `col1`; `A where col1 = 'foo'` retains them and adds the constant binding. When a downstream insert omits a value, the default is reachable per-attribute without a fresh walk back to the base.

Quereus' lineage walker already touches every attribute on the same pass that propagates FDs. Attaching the `AttributeDefault` record there is structurally free, and it produces three concrete wins:

1. **Defaults survive projection.** Today's `insert.ts:124` recovers defaults only by re-resolving the target `TableSchema`. With per-attribute defaults, the propagation pass dispatched into a projection-over-projection-over-filter view has the default at hand on the attribute ID, no second walk.
2. **Constant-FD defaults and base-column defaults unify under one chain.** Step 2 (constant FD) and step 6 (base-column default) of the doc's recovery chain become two *sources* of the same `AttributeDefault`; the propagation pass consults a single list ordered by source priority.
3. **`default_for` tags become a third source of the same record.** No separate code path.

The default-recovery chain (revised, attribute-centric):

1. The insert's value list (after applying the inverse of any scalar transformation in the projection).
2. For each missing column, walk the `AttributeDefault` chain on its attribute ID in source-priority order:
   1. `constant-fd` (predicate-derived, highest priority — the user wrote the predicate, it wins)
   2. `default-for-tag` (view-DDL annotation)
   3. `base-column` (declared `DEFAULT`)
3. EC propagation — a column in an EC with a supplied column takes the EC representative's value.
4. FD reconstruction — a column functionally determined by other supplied columns is reconstructed symbolically.
5. For nullable columns, `null`.
6. Otherwise: `no-default` diagnostic naming the column and the FD surface consulted.

Steps 3 and 4 stay in their current ordering relative to defaults because they're FD-driven *inference*, not defaulting — they produce a derivable value, not a fallback.

### Propagation dispatcher

```ts
function propagateMutation(target: RelationalPlanNode, op: UserMutation): BaseOp[]
```

In `packages/quereus/src/planner/mutation/propagate.ts` (new file). Visitor over the relation tree; each operator's `propagateMutation(childRelations, op)` returns child ops; leaf is `TableReferenceNode` which materializes a `BaseOp`. The complete list executes atomically in the user statement's transaction.

### Runtime orchestrator

The doc names `src/runtime/emit/view-mutation.ts` as the emitter that issues base operations in order and accumulates RETURNING rows. The implementer must decide between two structures:

- **Orchestrator wrapping reused `DmlExecutorNode`s** — each base operation is a standard `DmlExecutorNode` (existing emitter at `runtime/emit/dml-executor.ts`); a new `ViewMutationNode` plan node carries the ordered list (FK-parent before FK-child where provable) and the runtime emitter sequences their invocations under one transaction frame. Pro: maximal reuse, conflict-resolution clauses already plumbed per existing node. Con: new plan-node type.
- **New `ViewMutationExecutorNode`** that owns the per-base loop internally. Pro: no new wrapper plan-node-type. Con: duplicates upsert / conflict-resolution plumbing already in `DmlExecutorNode`.

**Pick the first** at implement-entry. Rationale: `DmlExecutorNode` already handles per-row constraint checking, OLD/NEW row descriptors, `UpsertClausePlan`, and integrates with the FD-aware constraint pipeline. A wrapper that calls into it preserves DRY and keeps the conflict-resolution composition (below) under one code path.

### Conflict resolution under fan-out

A view-mediated mutation can emit N base operations. The statement-level `OR` clause composes per-base-op as follows:

| Clause | Semantics under fan-out |
|---|---|
| `OR IGNORE` | Per-base-op IGNORE. A constraint violation on one base op drops *that* op's row; siblings continue. The user-visible mutation succeeds even if some base ops produced zero rows. |
| `OR REPLACE` | Per-base-op REPLACE. Each base op resolves UNIQUE/PK conflicts on its own table independently. A NOT-NULL conflict on a base op without that column's default falls through to ABORT *that op* (matching today's per-op semantics). |
| `OR FAIL` | At first base-op violation, abort the statement. Prior base ops in the same statement that already succeeded remain (per existing FAIL semantics). |
| `OR ABORT` (default) | At first base-op violation, abort the statement and undo prior base ops in the same statement. |
| `OR ROLLBACK` | At first base-op violation, abort the enclosing transaction unconditionally. |

The reason this can stay simple: `DmlExecutorNode` already implements per-op semantics on a single table. The orchestrator's job is sequencing and stop/continue policy — no new per-op work.

Seed tests must cover each row of the table. Add `93.3-view-mutation-or-clause.sqllogic` at phase 1 with one section per `OR` mode against a projection-and-filter view.

### `ChangeScope` for view-mediated writes

`Statement.getChangeScope()` (`planner/analysis/change-scope.ts`) reports base tables a statement may write to. A view-mediated mutation must expand the view's `effectiveTargets` and surface those bases — `update v ...` reports the union of `v`'s reachable base tables, with per-base bindings derived from the propagation pass (so `update v set col = 1 where pk = 5` reports a `row` binding on the underlying base, not `global`).

Reuse the propagation pass's per-base operation list as the source of truth: `ChangeScope` is the set of (base, binding) pairs from the propagation analysis, with `row` / `group` / `global` derived from the row-identifying predicate using the same FD analysis that `binding-extractor.ts` already runs forward. Without this, `Database.watch` against a base table will silently miss view-mediated writes.

### Diagnostics catalog

The doc's `MutationDiagnostic.reason` union maps to phases as follows:

| Reason | Raised by | Phase |
|---|---|---|
| `no-inverse` | Projection (non-invertible scalar on update path) | 1 |
| `no-default` | Projection (insert with missing NOT-NULL column after recovery chain) | 1 |
| `predicate-contradiction` | Filter (insert violates selection at plan time) | 1 |
| `recursive-cte` | CTEReference (recursive CTE as mutation target) | 1 (rejection only; transparent mutability for non-recursive CTEs is Phase 7) |
| `aggregate-target` | AggregateNode (write to aggregate output column) | 5 |
| `null-extended-create-conflict` | OuterJoin (materialization-required insert missing NOT-NULL value) | 4 |
| `tag-target-not-found` | Tag resolver (any tag with unknown branch / table) | 1 (tag parsing) + per-operator at consumption |

Each diagnostic includes a copy-pasteable `with tags ("quereus.update.default_for.col" = ...)` suggestion where one applies.

### Phase dependency graph

Phases are not strictly linear — mutation context is a substrate other phases stand on:

```
Phase 1 (projection + filter, single-base, literal/per-statement defaults)
  │
  ├─► Phase 1b (mutation-context envelope: per-row + shared-key threading)
  │       │
  │       ├─► Phase 2 (joins: inner + equi)
  │       │       │
  │       │       └─► Phase 4 (outer joins: null-extended materialization)
  │       │
  │       └─► Phase 3 (set operations)
  │
  ├─► Phase 5 (aggregates + groupings — mostly rejection)
  ├─► Phase 6 (RETURNING through views — depends on 1 minimum, 2+ for joins)
  └─► Phase 7 (subqueries-in-FROM / CTE as target — deferred)
```

Phase 1 ships with **literal and per-statement** defaults only. Per-row generators and shared-surrogate threading land in 1b. Phases 2 and 4 are gated on 1b — they cannot ship correctly on multi-base joins with shared FK keys without per-row context, because the doc's "Ada/Lin / `next_rid()`" example fails without it.

### Phase boundaries

**Phase 1 — single-source projection-and-filter (MVP).** The narrowest useful slice:

- `updateLineage` and `attributeDefaults` on every relational `PlanNode`, computed in the existing physical-properties pass (mirrors how `fds` / `equivClasses` already thread through).
- `TableReferenceNode` originates `base`-lineage and `AttributeDefault(source: base-column)` for every column.
- `ProjectNode`: invertible scalar expressions (**phase 1: identity and column-rename only**; `cast`-style and other passthroughs land in 1b's invertibility-classifier pass) preserve `base` lineage with the inverse recorded; non-invertible expressions produce `computed`. Attribute defaults pass through on the invertible path.
- `FilterNode`: pass-through lineage; filter predicate contributes constant-FD `AttributeDefault` synthetic entries.
- A propagation dispatcher (new `packages/quereus/src/planner/mutation/propagate.ts`) that walks a non-`TableReferenceNode` target, invokes per-operator `propagateMutation`, terminates at base-table references, and returns a list of base-table operations.
- `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` gain a view-aware path: if the target name resolves via `schemaManager.getView()` (rather than `findTable()`), build a plan of the view body and invoke propagation instead of erroring at `resolveTableSchema`.
- New `ViewMutationNode` orchestrator plan node + matching `runtime/emit/view-mutation.ts` emitter (per "Runtime orchestrator" decision).
- Conflict-resolution under fan-out (the per-OR table above) plumbed through `ViewMutationNode`.
- `Statement.getChangeScope()` expanded to surface view-mediated base writes.
- Sibling-ticket prereq fix (per "Coordination" section).
- **Test 93.1 § 2 flips to expected-pass for the projection-filter case.** § 1, § 3, § 4 stay verbatim — they're unrelated paths (post-drop reads, cross-type DDL).
- New `93.3-view-mutation-or-clause.sqllogic` covering each `OR` mode.

**Phase 1b — Mutation-context substrate.** Per-row and shared-key threading via the `with context` envelope:

- Per-row generator cadence (sequences, surrogate allocators, per-row `now_ms()`).
- Shared-surrogate threading across an n-way decomposition's branches (the doc's `rid` / `u_core` + `u_contact` example).
- Hook into the existing sequential-ID-generation infrastructure (`docs/architecture.md` § Sequential ID Generation). Per-statement cadence likely already exists there — verify and reuse.
- Extends Phase 1's invertibility classifier to cover `cast`-style wrappers, `coalesce(x, default)` on the FD-provable-non-null path, and other declarable `passthrough` / `inverse` profiles per the doc's `InvertibilityProfile` table.

**Phase 2 — joins (inner + equi).** Gated on 1b. Branch-consistency analysis using the existing predicate-normalizer and FD/EC pipeline. Each branch's accumulated predicate vs the mutation's predicate; provably-consistent fans out, provably-inconsistent skips, unknown includes (honest fan-out). Per the doc: "Branch Consistency" section.

**Phase 3 — set operations (`union all`, `union`, `intersect`, `except`).** Same propagation discipline; per-operator semantics per the doc. `union all` is the easy case (fan out to every branch); set ops with dedup semantics need care.

**Phase 4 — outer joins (`null-extended` lineage).** Gated on 1b. Updates against a null-extended column either materialize the missing side (consuming `attributeDefaults` for the non-preserved branch's NOT-NULL columns) or surface `null-extended-create-conflict`.

**Phase 5 — aggregates + groupings.** Mostly rejection-with-diagnostic (`aggregate-target`). The doc's per-operator section spells out which inverse cases (e.g. updating a non-grouping projected column) are still soundly propagatable.

**Phase 6 — RETURNING through views.** Project post-mutation state through the view's column list. **Pick the captured-per-op-results path** over view-body re-evaluation: `DmlExecutorNode` already produces OLD/NEW row descriptors (`insert.ts:481+`); the orchestrator collects them and the RETURNING projection assembles view-level rows from those captures. View-body re-evaluation would be O(view-body cost) per mutating statement on top of the writes themselves; capturing is one pass.

**Phase 7 — subqueries-in-FROM and CTE-as-target.** `update (select ...) set ...` and `update cte_name set ...` where `cte_name` is from an enclosing `with` clause. Reuse the propagation pipeline; deferred but in scope (the doc presents non-recursive CTEs as "transparently mutable", so this is the natural place to deliver that promise). Recursive CTEs remain read-only with the `recursive-cte` diagnostic from Phase 1.

The lens layer's foundational ticket (`lens-foundation-and-default-mapper`) gates on **Phase 1 + 1b** landing. Lens explicit overrides need at least Phase 2. The lens prover needs Phases 1–3 at minimum; Phase 4+ for full coverage.

### `information_schema` surface

The doc's `information_schema.views.{is_insertable_into, is_updatable, is_deletable, effective_targets}` section is **not** part of this ticket. After Phase 1 lands, file a separate plan ticket `view-information-schema-surface` in `backlog/` — it depends on the `attributeDefaults` / `updateLineage` surfaces this ticket produces and is independently reviewable.

### Test-file restructure

`test/logic/93.1-view-error-paths.sqllogic` § 2 (lines 23–41) is the only section that changes. § 1 (querying after base drop), § 3 (cross-type DDL errors), § 4 (ALTER TABLE on view) stay verbatim — they test unrelated paths. Phase 1 flips § 2's three assertions from `-- error:` to expected pass-cases.

Cases the propagation pass still rejects in Phase 1 (computed-lineage projections, set-op bodies, aggregate bodies, join bodies until Phase 2) move to a new `93.2-view-mutation-pending.sqllogic` so the test corpus stays an honest contract about what's shipped. As each later phase lands, cases migrate from `93.2` to a `93.<phase>` working-cases file.

### Backward compatibility

Phase 1's "now you can write through views" is a behavior change. No existing user code relies on "writes through views error" except as a negative test; the project is pre-1.0 per `AGENTS.md`. The 93.1 § 2 flip and the change-scope expansion to view targets are the only visible breaks; document in release notes when the implement ticket lands.

## Resolved Open Questions

- **One plan ticket or split per-phase?** One plan ticket (this one) maps the full surface; the implement stage decomposes into phase-1+1b first followed by additional implement tickets as the substrate stabilizes. This keeps the design coherent in one place and lets implementers proceed incrementally without re-litigating the design every phase.
- **Per-attribute defaults vs base-column lookup?** Per-attribute, Dataphor-style — see "Per-attribute default inference" above. The base-column lookup in `insert.ts:124` becomes one of several `AttributeDefault.source` kinds rather than a separate code path.
- **Orchestrator vs in-emitter loop?** Orchestrator (`ViewMutationNode` wrapping ordered `DmlExecutorNode` invocations). See "Runtime orchestrator" above.
- **RETURNING via re-evaluation vs captured ops?** Captured ops — `DmlExecutorNode` already emits OLD/NEW descriptors; the orchestrator collects them and assembles view-level rows via the view's projection. See Phase 6.
- **Doc as source of truth?** `docs/view-updateability.md` is the source of truth for *intent*; this ticket plus the actual code is the source of truth for *what's shipped at any moment*. The doc gets a "Status" preamble at implement-stage entry tracking which phases have landed.

## Out of scope (file in `backlog/` if a need surfaces)

- **`information_schema.views` surface** — landed as its own plan ticket after Phase 1 (see above).
- **Cross-engine compatibility shims** (e.g. mimicking PostgreSQL's `with check option` semantics). Per the doc: not a feature; `create assertion` is the supported replacement.
- **`update` driven by a recursive CTE.** Research-grade; recursive CTEs raise `recursive-cte` from Phase 1 forward.

## Implementation Surface

- `packages/quereus/src/planner/nodes/plan-node.ts` — add `updateLineage: ReadonlyMap<AttributeId, UpdateSite>` and `attributeDefaults: ReadonlyMap<AttributeId, AttributeDefault>` to the relational `PlanNode` interface; types for `UpdateSite` and `AttributeDefault`.
- `packages/quereus/src/planner/analysis/update-lineage.ts` (new) — single-pass lineage + default-inheritance computation; runs in the physical-properties phase alongside FD propagation. Reuses the same FD walk; **does not** fork analysis from `binding-extractor.ts`.
- `packages/quereus/src/planner/analysis/scalar-invertibility.ts` (new) — classify scalar expressions per the doc's `InvertibilityProfile`. **Phase 1: identity + column-rename only.** Phase 1b extends to passthroughs and declared inverses.
- `packages/quereus/src/planner/analysis/change-scope.ts` — expand to surface view-mediated base writes via the propagation pass output.
- `packages/quereus/src/planner/mutation/propagate.ts` (new) — propagation dispatcher.
- `packages/quereus/src/planner/nodes/project-node.ts` — `propagateMutation` method; lineage + default-pass-through rules.
- `packages/quereus/src/planner/nodes/filter.ts` — `propagateMutation`; lineage pass-through; constant-FD `AttributeDefault` synthesis.
- `packages/quereus/src/planner/nodes/join-node.ts` — `propagateMutation` with branch-consistency analysis (Phase 2); lineage union including `null-extended` for outer joins (Phase 4).
- `packages/quereus/src/planner/nodes/set-operation-node.ts` — `propagateMutation` per branch (Phase 3).
- `packages/quereus/src/planner/nodes/aggregate-node.ts` — `propagateMutation` with `aggregate-target` diagnostic (Phase 5).
- `packages/quereus/src/planner/nodes/view-mutation-node.ts` (new) — orchestrator plan node carrying the ordered per-base operation list, FK ordering, RETURNING capture, conflict-resolution policy.
- `packages/quereus/src/planner/nodes/dml-executor-node.ts` — no structural change; reused per-base-op by the orchestrator.
- `packages/quereus/src/runtime/emit/view-mutation.ts` (new) — instruction emitter for `ViewMutationNode`. Sequences base-op execution under the prevailing `OR` policy, collects RETURNING rows, ensures transaction-frame atomicity.
- `packages/quereus/src/planner/building/insert.ts` / `update.ts` / `delete.ts` — view-aware target resolution path: if `schemaManager.getView()` returns a `ViewSchema`, plan the view body, run the propagation pass, build a `ViewMutationNode` with the resulting per-base operation list.
- `packages/quereus/src/planner/building/table.ts` — add `resolveMutationTarget` (or extend `resolveTableSchema`) to return a discriminated `TableSchema | ViewSchema` for mutation builders.
- `test/logic/93.1-view-error-paths.sqllogic` — flip § 2 to pass-cases; leave § 1 / § 3 / § 4 untouched.
- `test/logic/93.2-view-mutation-pending.sqllogic` (new) — rejection cases for shapes Phase 1 does not handle (computed projections, set-op bodies, aggregate bodies, join bodies).
- `test/logic/93.3-view-mutation-or-clause.sqllogic` (new) — one section per `OR` mode against a projection-and-filter view.
- `docs/view-updateability.md` — add a "Status" preamble at implement-stage entry tracking shipped phases.
- `docs/architecture.md` — flip the "Predicate-Driven View Updateability" entry under "Key Design Decisions" from intent to phase-1-shipped as phases land.

## Key Tests (TDD seeds for implement stage)

**Phase 1 (load-bearing):**

- **GreenMen pattern.** `create view GreenMen as select * from Men where Color = 'green'; insert into GreenMen (Name) values ('Bob')` writes `(Name='Bob', Color='green')` to `Men` — constant-FD `AttributeDefault` from the filter.
- **AdultsBare pattern (projected-away column with constant FD).** `create view AdultsBare as select Name, Age from Adults where Country = 'US'; insert into AdultsBare values ('Bob', 30)` writes with `Country = 'US'` — the projected-away attribute's default survives via the lineage walk.
- **Base-column default survives projection.** `create table u (id int pk, name text default 'unknown'); create view v as select id from u; insert into v values (5)` writes `id=5, name='unknown'` — Dataphor-style default inheritance demonstrating the chain at step 2.iii.
- **Rename projection.** `create view V as select id as user_id, name as full_name from users; insert into V (user_id, full_name) values (1, 'Bob')` writes `id=1, name='Bob'` to `users`.
- **Computed-lineage rejection.** `create view V as select id, length(name) as name_len from users; insert into V (id, name_len) values (1, 5)` raises `no-inverse` naming `name_len` as the obstructing column.
- **Predicate contradiction.** `create view V as select * from t where x = 1; insert into V (x) values (2)` raises `predicate-contradiction`.
- **Filter pass-through delete.** `create view ActiveUsers as select * from users where active = true; delete from ActiveUsers where id = 5` emits a base delete on `users where id = 5 and active = true` (the filter is part of the row-identifying predicate, **not** a post-hoc constraint).
- **Conflict resolution under fan-out.** `93.3` covers each of `IGNORE` / `REPLACE` / `FAIL` / `ABORT` / `ROLLBACK` against a projection-filter view with at least one base-op-level constraint violation.
- **`Statement.getChangeScope()` reports base, not view.** `prepare update v set col = 1 where pk = 5; getChangeScope()` returns the underlying base's row binding.
- **`Database.watch` against base sees view-mediated write.** Watcher on `Men` sees the GreenMen-via-Bob insert (no new watcher code required — `ChangeScope` expansion should make this Just Work).

**Phase 1b (mutation context):**

- **Per-row generated default.** `create table t (id int pk default next_id(), v int); create view v_only as select v from t; insert into v_only values (10), (20)` mints two distinct `id`s, captured in the mutation context for replay.
- **Per-statement timestamp.** `create table audit (...); create view v as ...; insert into v with context now=epoch_ms('now') ...` stamps the same `now` across every base op of every row.

**Phase 2 (joins) — substrate-dependent:**

- **Shared-surrogate insert across two bases.** The doc's `u_core` + `u_contact` example with `next_rid()` per row, threaded through the join EC into both base inserts.
- **Insert into join view, fan-out to both branches.** Per the doc's "Branch Consistency".
- **Insert into join view, predicate selects one branch.** Provably-consistent fan-out.
- **Update through inner join with cross-base SET.** Two child operations, atomically.

**Phase 3+** — per-phase seeds, expanded at phase entry.

**Cross-phase (regression bedrock):**

- **Test 93.1 § 2 flip.** The single-section change from "all view writes error" to "projection-filter view writes succeed" is captured cleanly; § 1 / § 3 / § 4 byte-equal before and after.
- **Constraint enforcement composes.** A NOT-NULL or CHECK violation on a base column during view-mediated insert raises with the existing diagnostic. Conflict-resolution clauses propagate per-base-operation (covered by 93.3).
- **CTE inlining for non-recursive CTEs in view body.** `create view v as with cte as (select ...) select * from cte` is updateable iff the inlined plan is updateable — propagation operates on the unfolded plan.

## Plan-stage output

When this ticket is processed in `plan/`, the plan agent should produce:

- **One `implement/` ticket** covering Phase 1 + Phase 1b (slug: `view-updateability-phase-1`). Phase 1b is bundled with Phase 1 because Phases 2 and 4 are gated on the per-row context substrate, and shipping projection-and-filter without it commits the codebase to a default chain that has to be re-plumbed once context lands. The implement ticket's TODO is derived from the "Phase boundaries" / "Implementation Surface" sections above plus the "Key Tests" seeds; the plan agent does the decomposition, the implement agent does the work.
- **One `backlog/` stub** for the deferred `information_schema.views` surface (slug: `view-information-schema-surface`), prereq'd on the Phase 1 implement ticket.
- **Two `prereq:` edits** on the sibling plan tickets `1-lens-foundation-and-default-mapper.md` and `1-materialized-view-core.md`, adding `view-updateability-implementation` so the runner's cross-stage gate defers them while this chain runs. Do this inline during the plan-stage transition rather than carrying it forward into the implement ticket — it's a single-line edit that costs nothing now and prevents the runner from racing them.

Phases 2 through 7 each get their own plan→implement→review track in subsequent runs, chained via `prereq: view-updateability-phase-1`. The plan ticket for each later phase is small — the design lives in `docs/view-updateability.md` and in the "Phase boundaries" section above, so the per-phase plan tickets are essentially "implement this phase's slice of the design with these tests" and can be filed from `backlog/` as each prior phase reviews clean.
