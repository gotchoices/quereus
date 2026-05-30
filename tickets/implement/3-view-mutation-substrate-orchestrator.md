----
description: Build the substrate that consumes the `updateLineage` surface from `view-mutation-physical-lineage` and becomes the **single propagation path for ALL view mutations** — single- and multi-source. (1) A `propagate.ts` visitor that walks the PLANNED (not AST-rewritten) view body from the user-visible relation to base tables and emits an ordered `BaseOp[]` — the multi-source generalization of today's single-source `classifyViewBody` gate. (2) A `ViewMutationNode` orchestrator + `runtime/emit/view-mutation.ts` over reused `DmlExecutorNode`s that sequences base ops, composes conflict resolution across ops, orders FK-parent before FK-child, and captures RETURNING-through-views. (3) **Retire the Phase-1 AST rewrite** (`building/view-mutation.ts`): route single-source projection-and-filter writes through the substrate (a `ViewMutationNode` over exactly one `BaseOp`, bit-for-bit parity to the retired rewrite), then delete `building/view-mutation.ts` and migrate its callers — the Phase-1 view-DML builders AND `materialized-view-rowtime-write-through`. (4) The `quereus.update.*` override surface (`target` / `exclude` / `delete_via` / `policy` / `default_for.<column>`) validated + read through the typed reserved-tag registry (`schema/reserved-tags.ts`) — no hand-rolled tag parser. (5) Extend the `bx-roundtrip-law-harness` block with dynamic PutGet/GetPut over the planned multi-source tree (the derived-put acceptance gate). Design source: `docs/view-updateability.md` § Mutation Propagation, § Per-Operator Semantics, § Tags, § returning Clauses, § Multi-Base-Table Mutations.
prereq: view-mutation-physical-lineage
files: packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/view-update.sqllogic, docs/view-updateability.md
----

## Decision context (settled — do not re-litigate)

The AST rewrite is **retired**. The substrate is the single propagation path for all
view mutations; the single-source case is its trivial one-base-op path. A permanent
two-tier dispatcher (AST fast path + substrate) is exactly the two-codepaths-for-one-
semantics debt the `bx` derived-dual discipline exists to eliminate. This ticket lands
the substrate, proves single-source parity through it, then deletes the rewrite.

## 1. `propagate.ts` visitor — planned-body → ordered `BaseOp[]`

Generalize `planner/mutation/propagate.ts` from the current `classifyViewBody` (which
only *classifies* a single-source spine) into a propagation visitor that walks the
**planned** body and emits base ops. It reads the `updateLineage` / `attributeDefaults`
that `view-mutation-physical-lineage` threaded onto each node — it does NOT re-derive
lineage and does NOT touch `selectAst` (this is the structural reason the substrate
generalizes where the AST rewrite cannot: it sees inner view/CTE filters that live in
the plan, not the outer AST).

```typescript
interface MutationRequest {
	readonly op: 'insert' | 'update' | 'delete';
	readonly assignments?: ReadonlyMap<AttributeId, ScalarExpr>;  // update
	readonly insertValues?: ...;                                  // insert existence predicate inputs
	readonly userPredicate?: PredicateExpr;                       // where / values-derived
	readonly tags: ReadonlyMap<string, string>;                  // merged view + statement tags
}

interface BaseOp {
	readonly table: TableReferenceNode;
	readonly op: 'insert' | 'update' | 'delete';
	readonly assignments?: ...;        // base-column setters (post-inverse)
	readonly rowIdentifyingPredicate?: PredicateExpr;  // update/delete
	readonly values?: ...;             // insert, with defaults filled
	readonly conflictMode?: ...;       // inherited / per-op
}

export function propagate(body: RelationalPlanNode, req: MutationRequest): BaseOp[];
```

One method per operator, mirroring `runtime/emit/` (§ Per-Operator Semantics):

- **Projection** — updates rewrite assignments against base columns via the `UpdateSite`
  inverse chain; computed targets → `no-inverse` diagnostic. Inserts fill missing base
  columns from the source order: value list (post-inverse) → constant-FD `attributeDefault`
  → FD reconstruction → EC propagation → `default_for` tag → base column default
  (incl. generated/context default) → `null`; a `not null` column with no value →
  `no-default` diagnostic.
- **Selection** — conjoin σ predicate into the propagated/identifying/existence predicate;
  detect provable contradiction → `predicate-contradiction`.
- **Inner Join** — route per-column updates to the owning side (two ops if a `set`
  touches both); inserts require both sides' `not null`-without-default values and emit
  FK-parent before FK-child; deletes follow the `delete_via` default (§ Inner Join).
- **Set-ops / outer joins / aggregates / windows** — keep emitting the structured
  diagnostics for the shapes still out of scope, but now from the planned walk. (This
  ticket targets the **multi-source key-preserving inner-join** acceptance case; broader
  set-op/outer-join propagation stays diagnosed-and-rejected and is a later phase. Document
  precisely which shapes newly succeed vs still reject.)

The single-source spine (Project/Filter/Sort/passthrough → one TableReference) MUST
produce exactly one `BaseOp` whose conflict/FK/RETURNING/mutation-context behavior
matches the retired rewrite. The Phase-1 `LIMIT`/`OFFSET`/`DISTINCT` write-widening
rejection and the alias-qualifier handling move into the planned walk (the round-trip law
from `bx-roundtrip-law-harness` already locks these closed as property failures — keep
them green).

## 2. `ViewMutationNode` + `runtime/emit/view-mutation.ts`

A new relational/DML plan node (`planner/nodes/view-mutation-node.ts`) that holds the
ordered `BaseOp[]` as reused child `DmlExecutorNode`s (one per base op), plus the
RETURNING projection (view column list, evaluated per § returning Clauses). The emitter
(`runtime/emit/view-mutation.ts`, mirroring the node 1:1 per `runtime/emit/` convention):

- Executes the base ops in order within the statement transaction (§ Multi-Base-Table
  Mutations): FK-parent before FK-child where provable, unspecified within an FK class.
- Composes conflict resolution across ops — the prevailing `or` mode applies per base op;
  same-row same-table fan-out merges when effects are identical, conflicts otherwise
  (§ Union All tail).
- Captures RETURNING rows projected through the view's column list, evaluated against
  post-mutation base values (computed-lineage columns re-evaluated).
- Threads the per-statement / per-row mutation-context envelope so a shared surrogate
  (join key) generated per row threads through every branch (§ Mutation Context) — reuse
  the existing context machinery; the single captured per-row value is resolved at the
  envelope before propagation reaches the branches.

For the single-source case the node wraps exactly one `DmlExecutorNode` and the emitter
degenerates to a passthrough — this is the parity path.

## 3. Retire the AST rewrite + migrate callers

- Route the Phase-1 view-DML builders (callers of `rewriteViewInsert` / `rewriteViewUpdate`
  / `rewriteViewDelete` in `building/insert.ts` / `update.ts` / `delete.ts` — confirm exact
  call sites) to build a `ViewMutationNode` via `propagate()` instead.
- Migrate `materialized-view-rowtime-write-through` (shipped; rides the AST rewrite today)
  to the substrate with **no behavior change** — find its rewrite consumption and repoint it.
- Delete `planner/building/view-mutation.ts` once single-source parity is proven (the
  regression assertion below is green).
- Update `docs/view-updateability.md`: the AST rewrite is retired; the substrate's
  single-source case is its trivial one-base-op path (the Status table already anticipates
  this — flip Phase 1's "AST rewrite" note to "via substrate" and mark the relevant
  Phase-2 rows shipped for the inner-join case).

**Regression assertion (parity gate):** a single-source projection-filter view write
constructs a `ViewMutationNode` over exactly one `BaseOp` with conflict / FK / RETURNING /
mutation-context parity to the retired rewrite. Add this as an explicit test before deleting
`building/view-mutation.ts`.

## 4. `quereus.update.*` override surface via the reserved-tag registry

Read + validate every `quereus.update.*` tag through `schema/reserved-tags.ts`
`validateReservedTags(tags, site)` — the registry already defines `target` / `exclude` /
`delete_via` / `policy` / `default_for.` with their sites and value schemas. This ticket
realizes their **Effect** (the registry only validates shape/site):

- Collect tags at their sites (view DDL, union branch, join, dml statement, projection),
  validate with the matching `TagSite`, and surface any error/warning as a sited diagnostic
  (an unknown or mis-sited reserved key is a hard error — the registry returns the issue;
  raise it with location).
- Merge statement-level tags over view-level tags for the statement's duration.
  NOTE: the registry currently sites `quereus.update.default_for.<column>` at `view-ddl` /
  `projection` only (not `dml-stmt`), yet `docs/view-updateability.md` shows a statement-level
  `insert into v with ("quereus.update.default_for.created" = …)`. Reconcile: either add
  `dml-stmt` to that key's `sites` in `schema/reserved-tags.ts` (preferred — matches the doc
  example) or pin the doc to view-level only. Decide and make registry + doc agree; do not
  leave them divergent. Same check for `target`/`exclude`/`policy` statement-site coverage.
- Feed validated tags into `MutationRequest.tags`; the propagation visitor consumes them:
  `target`/`exclude` narrow the candidate base set (never broaden past predicates);
  `default_for.<col>` supplies an omitted insert value; `delete_via` picks the deletion
  side; `policy=strict` rejects any residual ambiguity. Do NOT hand-roll a tag parser.

## 5. Round-trip law — dynamic multi-source PutGet/GetPut

Extend the `bx-roundtrip-law-harness` block (the static lineage-agreement coverage landed
in `view-mutation-physical-lineage`) with **dynamic** PutGet / GetPut over the planned
multi-source tree, executed through the substrate:

- **PutGet** — apply a generated mutation through a multi-source view (key-preserving
  equi-join), read the view back, assert the read reflects exactly the mutation's writable-
  column effect; no rows escape the view predicate; computed-column writes rejected with
  `no-inverse`; a forward-claimed key is the tuple the backward walk bound.
- **GetPut** — read a row through the view, write the same values back keyed on the view's
  identifying predicate, assert the base diff is empty across all touched base tables.

This is the **acceptance gate** for every operator backward method the substrate threads —
a new operator is not "done" until these are green over a planned tree surfacing it.

## Acceptance (from the plan ticket)

- A multi-source view body (key-preserving equi-join) decomposes to an ordered base-op
  list and writes through correctly, with conflict / FK / RETURNING parity to hand-written
  base DML.
- `query_plan()` surfaces per-output-column lineage (already from ticket 2; confirm intact).
- `bx-roundtrip-law-harness` PutGet / GetPut / lineage-agreement green over the planned
  multi-source tree for every operator the substrate threads.
- Phase 1's single-source cases pass **through the substrate**; `building/view-mutation.ts`
  removed; rowtime-write-through migrated with no behavior change.
- Any `quereus.update.*` tag validated through the reserved-tag registry; unknown/mis-sited
  reserved key → sited diagnostic.

## TODO

- [ ] Generalize `propagate.ts`: `MutationRequest` / `BaseOp`, per-operator methods over the
      planned body reading `updateLineage` / `attributeDefaults`.
- [ ] Insert default-fill chain; update inverse-chain rewrite; delete/identifying-predicate
      construction; inner-join per-column routing + FK ordering.
- [ ] `ViewMutationNode` (`nodes/view-mutation-node.ts`) over reused `DmlExecutorNode`s.
- [ ] `runtime/emit/view-mutation.ts`: ordered execution, conflict composition, FK order,
      RETURNING capture, mutation-context threading.
- [ ] Route single-source view DML through the substrate; add the one-BaseOp parity test.
- [ ] Migrate `materialized-view-rowtime-write-through` to the substrate (no behavior change).
- [ ] Delete `building/view-mutation.ts`; remove its imports/exports.
- [ ] `quereus.update.*` collection + `validateReservedTags` wiring + sited diagnostics +
      statement-over-view tag merge + propagation consumption.
- [ ] Extend `bx-roundtrip-law-harness` with dynamic multi-source PutGet/GetPut.
- [ ] Multi-source `view-update.sqllogic` cases (equi-join write-through, RETURNING, FK order,
      shared-surrogate insert per § Mutation Context worked example).
- [ ] Update `docs/view-updateability.md` Status + Implementation note (rewrite retired).
- [ ] `yarn workspace @quereus/quereus test` + lint green; note any deferred shapes precisely.
