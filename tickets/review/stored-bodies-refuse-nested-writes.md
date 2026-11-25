description: Views, materialized views, maintained tables and assertions are now refused at create time when an insert/update/delete … returning sits anywhere inside their body (a from source, a subquery, a union arm, a write through another view), not only when it is the whole body; review the check, its call sites and the catalog-reload gap noted below.
architecture: docs/sql-views.md
files: packages/quereus/src/planner/building/reject-stored-body-writes.ts (new), packages/quereus/src/planner/building/create-view.ts (`planViewBody`), packages/quereus/src/planner/building/create-assertion.ts (`planAssertionBody`), packages/quereus/src/planner/nodes/plan-node-type.ts (`DML_NODE_TYPES`), packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/building/{ddl,alter-table,materialized-view,with}.ts, packages/quereus/src/schema/manager.ts (`importView`, `importMaterializedView` — not changed, see gaps), packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic, docs/sql-views.md, docs/sql-select-cte.md, docs/determinism.md, docs/runtime.md, docs/view-updateability.md
----

# Stored bodies refuse nested writes — review handoff

Reported from SiteCAD (they have closed the hole on their side; they will bump their Quereus pin and add their own test once this ships).

## What changed

A *stored body* — a view, materialized-view or maintained-table body, or an assertion's `check` — may no longer contain an `insert` / `update` / `delete … returning` at any depth. Before, only a write as the whole body (`planViewBody`'s switch) or as a non-leading `with` member (`rejectNestedDataModifyingCte`) was refused; a write as a `from` source, in a scalar / `exists` / `in` subquery, or in a `union` arm was accepted, and every evaluation of the object then performed the write (a materialized view even performed it while populating).

- `planner/building/reject-stored-body-writes.ts` — `rejectStoredBodyWrites(plan, kind, name)`: an iterative `getChildren()` walk over the built plan that throws on the first node whose `nodeType` is in `DML_NODE_TYPES`. It reads `nodeType`, never `physical.readonly`, so a call to a user-defined function registered as having side effects (`isReadOnly: false`) stays accepted. Message: `View 'v' body contains a DELETE on 'e' — a stored body is re-evaluated on every reference, which would re-drive the write. Move the mutation into the statement that uses this view, or call a function registered with side effects if the write is intended.` (`an` for INSERT / UPDATE). Unsited — plan nodes carry no source location.
- `planViewBody` gained a `kind: StoredBodyKind` parameter (`'view' | 'materialized view' | 'maintained table'`) and runs the check after planning; the four callers (create view, create materialized view, `create table … maintained as`, `alter table … set maintained as`) pass their kind. The whole-body switch moved into a private `planViewBodyShape`, unchanged. The check runs at build time, before any emitter, so a refused materialized view populates nothing.
- `planAssertionBody` runs the check on the built violation query inside its existing `try`, so the error reads `Cannot create assertion 'a': Assertion 'a' body contains a DELETE on 'e' — …` (the name appears twice; accepted as the cost of reusing the one message).
- `DML_NODE_TYPES` moved from a private constant in `analysis/change-scope.ts` to an export of `nodes/plan-node-type.ts`; contents unchanged (`Insert`, `Update`, `Delete`, `UpdateExecutor`); change-scope imports it.
- Docs: sql-views.md § 2.8 (DML anywhere refused; the side-effecting-function route), sql-select-cte.md (non-CTE nested DML stays legal in ordinary statements; refused only in stored bodies), determinism.md (assertion DML is refused by the stored-body check, not the determinism enforcer — the old claim was false), runtime.md and view-updateability.md (one-line widenings), with.ts doc comment on `rejectNestedDataModifyingCte`.

## Tests added (all in `test/logic/01.9-query-expr-dml-gates.sqllogic`)

- View with DML as a `from` source (the SiteCAD shape) — refused.
- View with DML in a scalar subquery — refused.
- Materialized view with DML as a `from` source — refused, and the final `select` from the source shows row 14 still present (refusal happens before population).
- View whose body deletes through another view (`delete from v_e …`) — refused with `DELETE on 'e'`, which confirms the `ViewMutation` node wraps the base-table DML and the walk reaches it without adding `ViewMutation` to the shared set.
- After all of the above, the source table still holds every row (no refused create wrote anything).
- Assertion with DML inside `not exists (…)` — refused; a following unrelated `insert` succeeds.

Verified ad hoc (not added as tests, they share the same walk): `create table … maintained as` and `alter table … set maintained as` with nested DML (refused, `Maintained table 'm' …`), DML in an `in (…)` subquery and in a `union all` arm (refused), DML in a scalar subquery inside a `values` body (refused, `an INSERT`), and a view calling a non-deterministic UDF (accepted). The side-effecting-function case is verified by inspection only (the walk never reads `physical.readonly`).

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn test` — all green (quereus 11186 passing / 23 pending, plus every other workspace).
- `yarn test:store` — 11179 passing / 30 pending.
- `01.9-query-expr-dml.sqllogic`, `01.9.1-limit-over-dml-subquery.sqllogic`, `13.12-nested-dml-cte-rejected.sqllogic`, `93.*`, `53.1-materialized-view-write-through` all inside the green runs above (ordinary statements and write-through-a-view are unaffected: write-through lowering uses `bodyPlanningContext`, not `planViewBody`).

## Known gaps / things for the reviewer to weigh

- **Catalog reload does not run the check.** The ticket asked which path reload takes. Answer: `SchemaManager.importDDL` (schema/manager.ts), not `buildCreateViewStmt`.
  - Plain views go through `importView`, which never plans the body (planning is deferred to first reference). A view with nested DML persisted before this fix therefore still loads, and still writes on every reference. Nothing on the read path refuses it.
  - Materialized views and maintained tables go through `importMaterializedView`, whose AST gate refuses only a *whole-body* DML ("a corrupt or hand-edited catalog entry would otherwise EXECUTE the mutation against live source tables during rehydrate"). A nested write passes that gate and then executes during rehydrate, when `materializeView` fills the backing. The body is planned there by `deriveBackingShape` (runtime/emit/materialized-view-helpers.ts) via `_getPlanWithDependencies`. One `rejectStoredBodyWrites(plan, 'materialized view', viewName)` call in `deriveBackingShapeUnguarded` would close the MV/maintained arm, at the cost of re-checking on create and refresh, where the check already ran. I left it out because the ticket scoped reload as note-only and the backwards-compatibility policy is "don't worry yet". The only remaining way to hit it is a hand-edited or pre-fix catalog. The reviewer should decide whether this is a latent defect worth a `debt-` ticket.
- **Schema unwind.** `buildCreateViewStmt` still skips body planning during an unwind, so the check is skipped too. The maintained-table (`ddl.ts`, `alter-table.ts`) and materialized-view builders have no unwind guard today: they planned the body during an unwind before and still do, so they now also run the check. That would only change behaviour if the pre-apply catalog held a nested-DML body, which can no longer be created.
- **Message names the base table for a write through a view.** `delete from v_e …` reports `DELETE on 'e'`, because the walk stops at the first base DML under `ViewMutation`. Acceptable, though a user might expect the view's name.
- `view_info` (func/builtins/schema.ts) plans view bodies without `planViewBody`; it is unaffected, and such views can no longer be created anyway.
