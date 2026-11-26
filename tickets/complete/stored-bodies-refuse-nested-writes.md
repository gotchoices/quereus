description: Views, materialized views, maintained tables and assertions are refused at create time when an insert/update/delete … returning sits anywhere inside their body, not only when it is the whole body; a plain view reloaded from a saved catalog is now also refused when read.
architecture: docs/sql-views.md
files: packages/quereus/src/planner/building/reject-stored-body-writes.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/building/create-assertion.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/building/{ddl,alter-table,materialized-view,with}.ts, packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic, packages/quereus/test/view-mv-ddl-persistence.spec.ts, docs/sql-views.md, docs/sql-select-cte.md, docs/determinism.md, docs/runtime.md, docs/view-updateability.md
----

# Stored bodies refuse nested writes

Reported from SiteCAD (closed on their side; they will bump their Quereus pin and add their own test once this ships).

## What shipped

A *stored body* — a view, materialized-view or maintained-table body, or an assertion's `check` — may not contain an `insert` / `update` / `delete … returning` at any depth: as the whole body, a `from` source, a scalar / `exists` / `in` subquery, a compound arm, or a write through another view. Before, only a whole-body write or a non-leading `with` member was refused, and every evaluation of the object re-ran the write (a materialized view ran it while populating).

- `planner/building/reject-stored-body-writes.ts` — `rejectStoredBodyWrites(plan, kind, name)` walks the built plan (`getChildren()`, iterative, visited set) and throws on the first node in `DML_NODE_TYPES`. It reads node types, not `physical.readonly`, so a call to a function registered with side effects stays accepted.
- Called from `planViewBody` (create view, create materialized view, `create table … maintained as`, `alter table … set maintained as`), from `planAssertionBody`, and — added in review — from the view read path in `planner/building/select.ts`, where a plain view's body is planned on first read.
- `DML_NODE_TYPES` moved to `nodes/plan-node-type.ts` and is shared with change-scope analysis.
- Implement commit: `ticket(implement): stored-bodies-refuse-nested-writes`.

## Review findings

**Checked:** the implement diff in full; every `planViewBody` caller; DML node shapes (`InsertNode` / `UpdateNode` / `DeleteNode` / `DmlExecutorNode` all carry `table`, `DmlExecutorNode.operation` is the lowercase `RowOp`); the CTE reference node's children; the catalog reload paths (`importView`, `importMaterializedView`, `deriveBackingShape`); the docs the change touched. Ran ad hoc: a leading DML `with` member, used and unused, in a view (both refused by the existing `with` check); an upsert (`insert … on conflict do update … returning`) as a `from` source; an update in a scalar subquery in a `where`; an assertion; a delete through another view. All refused, and the source table was unchanged afterwards.

**Found and fixed in this pass:**
- *Performance — exponential walk over shared CTE subtrees.* A plan is a graph where nodes can be shared, not a tree: every reference to a CTE returns the same CTE plan node as its child. So a chain of CTEs, each reading the previous one twice, was walked 2^depth times. Measured with `create view` over such a chain: depth 20 took 277 ms and depth 22 took 1111 ms (about ×4 per two levels). With a visited set, the same cases took 11 ms and 43 ms. (`PlanNodeCharacteristics.subtreeHasSideEffects` has the same walk shape but exits early on any side effect; it was left alone.)
- *Error message — the assertion remedy did not fit.* It said to "move the mutation into the statement that uses this assertion", but nothing uses an assertion; it runs at commit. The message now gives assertions their own reason and remedy (`redriveAdvice`). The sqllogic expectations match a prefix of the message and are unaffected.
- *Latent defect — a reloaded plain view still wrote on every read.* `importView` does not plan the body, so a view persisted before this check (or hand-edited) loaded and ran its nested write on every reference. Verified: it deleted the row on `select`. The read path in `select.ts` already threw on a whole-body DML view defensively, so the nested check now runs right beside that throw. Such a view now fails to read and writes nothing. A regression test was added in `view-mv-ddl-persistence.spec.ts` ("a reloaded view with a nested write is refused on read"), and `docs/sql-views.md` § 2.8 now says so.

**Filed:** `bug-materialized-view-reload-runs-nested-write` (backlog, repro verified). Reloading a materialized view or maintained table whose body has a nested write runs that write against the live source tables during rehydrate. `importMaterializedView`'s gate refuses only a whole-body write, and the same hazard is the reason that gate exists. This was not fixed inline because the plan is built inside `deriveBackingShape`, which has about ten callers and no view name, and planning a second time at the import site would double the planning cost of every materialized-view reload. The ticket also notes that assertions loaded from a catalog are a third reload path to decide on there.

**Tests:** the implementer's six sqllogic cases each pin a distinct position or contract: the `from` source, a scalar subquery, a materialized view not populated on refusal, the `ViewMutation` node reaching the base-table DML, no write by any refused create, and the assertion. All were kept. One spec was added for the reload defect found here. No test was added for the visited set; it is a performance property, and the ad hoc timing above is the evidence.

**Accepted as-is (no change):**
- A write through a view reports the base table (`DELETE on 'e'`) rather than the view. The message is accurate, and naming the view would need a `ViewMutation`-aware walk.
- On schema unwind, `buildCreateViewStmt` skips the check, as the handoff describes. Nothing to do, since such bodies can no longer be created.
- `view_info` plans view bodies without the check. That is read-only introspection, and the read path now refuses the body anyway when the view is used.

**Not found:** no type-safety issues (`DmlPlanNode` narrowing is sound for all four node types); no resource cleanup concerns (a pure plan walk); file sizes are small (`reject-stored-body-writes.ts` is about 70 lines).

**Validation:** `yarn build` clean; `yarn lint` clean; `yarn test` all green (quereus 11187 passing / 23 pending, plus every other workspace). `yarn test:store` was not re-run in review: the review changes are planner-only and module-independent, and the implement pass ran it green.
