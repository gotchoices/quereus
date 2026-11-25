description: A view, materialized view, maintained table or assertion can be created with an `insert`/`update`/`delete … returning` tucked inside a subquery, and every later evaluation of it then performs that write; creating such an object should be refused, as it already is when the write is the whole body or sits in a `with` clause.
architecture: docs/sql-views.md
files: packages/quereus/src/planner/building/create-view.ts (`planViewBody`), packages/quereus/src/planner/building/create-assertion.ts (`planAssertionBody`), packages/quereus/src/planner/analysis/change-scope.ts (`DML_NODE_TYPES`), packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/building/with.ts (`rejectNestedDataModifyingCte` doc comment), packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic, docs/sql-views.md, docs/sql-select-cte.md, docs/determinism.md
repro: verified
----

# Stored bodies refuse nested writes

Reported from SiteCAD. SiteCAD has already closed the hole on its side, so nothing there waits on this ticket. Once this ships, SiteCAD moves its Quereus pin and adds its own test.

## The rule

A *stored body* is a query that Quereus saves and evaluates again later: a view body, a materialized-view body, a maintained-table body (`create table … maintained as …`, `alter table … set maintained as …`), and an assertion's `check` expression. A stored body may not contain a data-modifying statement (`insert`, `update` or `delete … returning`) at any depth. That covers a `from` source, a scalar / `exists` / `in` subquery, a compound (`union`) arm, and anything nested inside those. The object is refused when it is created.

Two shapes are already refused:

- A write as the whole body. `planViewBody` throws `… cannot be used as a view body — a view re-evaluates on every reference, which would re-drive the write.`
- A write as a `with` member anywhere except a statement's own leading `with`. `rejectNestedDataModifyingCte` in `building/with.ts` handles this.

A write used as a subquery source or subquery expression gets past both checks. That is the gap this ticket closes. Ordinary statements are unaffected: `select … from (delete … returning …)` run directly stays legal and keeps the semantics documented in docs/sql-select.md.

**Calling a function that writes stays allowed.** A view body may call a user-defined function registered as having side effects (not `readonly`), and that function runs on every evaluation. This is the deliberate route for a view that really needs side effects, and its flags make the effect visible. So the new check must look for **DML plan nodes specifically**. It must not use `PlanNodeCharacteristics.subtreeHasSideEffects`, which would also catch those function calls.

## Reproduction (verified 2026-11-25 against the local build)

```sql
create table E (id integer primary key);
insert into E values (11), (12), (13), (14);
create view V1 as select id from (delete from E where id = 11 returning id) d;          -- accepted
create view V2 as select (select id from (delete from E where id = 12 returning id)) as x; -- accepted
create view V4 as select id from E union all select id from (delete from E where id = 14 returning id); -- accepted
create materialized view M1 as select id from (delete from E where id = 14 returning id) d; -- accepted, AND deletes row 14 while populating
select id from V1;  -- deletes row 11
```

Assertion variant, in a fresh database:

```sql
create table E (id integer primary key);
insert into E values (11), (13);
create assertion A1 check (not exists (select 1 from (delete from E where id = 13 returning id)));  -- accepted
insert into E values (20);  -- fails: Integrity assertion failed: A1 — unrelated writes are now blocked
```

docs/determinism.md says DML inside an assertion expression is rejected by the determinism enforcer. That is not true at create time. Correct the doc as part of this ticket.

## Design

Use one shared plan-tree check, called by the two functions that plan stored bodies when they are authored:

- `planViewBody` (`building/create-view.ts`) is already the single authoring-time planner for `create view`, `create materialized view`, `create table … maintained as` (`building/ddl.ts`) and `alter table … set maintained as` (`building/alter-table.ts`). Call the check on the relational node it builds, before returning. For a materialized view the check then runs before the emitter populates the view, so a refused create writes nothing.
- `planAssertionBody` (`building/create-assertion.ts`) builds the violation query with `buildSelectStmt`. Call the check on that result. It is inside the existing `try`, so the error picks up the `Cannot create assertion '<name>': …` prefix. Keep it that way.

The check walks the built plan iteratively with `getChildren()`, the same worklist shape as `subtreeHasSideEffects`. `ScalarSubqueryNode`, `InNode` and `ExistsNode` return their inner relation from `getChildren()`, so subquery expressions are reached. It throws on the first node whose `nodeType` is in the set of DML node types: `Insert`, `Update`, `Delete` and `UpdateExecutor`.

That set already exists as a private constant `DML_NODE_TYPES` in `planner/analysis/change-scope.ts`. Move it next to the enum in `planner/nodes/plan-node-type.ts`, export it, and have change-scope import it, so the two cannot drift. Keep its contents unchanged. A write against a *view* inside a body plans as a `ViewMutation` node, which wraps base-table DML subtrees, so the walk reaches the base `Insert`/`Update`/`Delete` beneath it. Confirm this with the view-target case below rather than adding `ViewMutation` to the shared set, which would change change-scope's classification.

The check goes on the plan, not the syntax tree, because every builder position that admits nested DML funnels into `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt`, and those always produce one of these node types. A position added later is covered without editing the check. The alternative, a flag on `PlanningContext` checked at the four nested-DML call sites (`expression.ts`, `select.ts` subquery source, `select-compound.ts`, `insert.ts` source), was rejected for two reasons. It has to be kept in sync with every future call site. And `storedBodyOf` is also set on the view write-through path (`mutation/scope-transform.ts`), so keying a refusal on it risks refusing a user's own legal statement that writes through a view.

Put the helper in its own small module under `planner/building/` (for example `reject-stored-body-writes.ts`), taking the plan, an object-kind word for the message, and the object name. Error text, in the style of the existing two messages: `<kind> '<name>' body contains a <INSERT|UPDATE|DELETE> on '<table>' — a stored body is re-evaluated on every reference, which would re-drive the write. Move the mutation into the statement that uses this <kind>, or call a function registered with side effects if the write is intended.` Use `StatusCode.ERROR`. If the DML node carries no source location, an unsited error is acceptable.

## Edge cases & interactions

- **Each nested position the reproduction covers**: from source, scalar subquery, `exists`, compound arm. All reach a DML node through `getChildren()`. Verify the from source and scalar-subquery cases with tests. The others are verified by inspection, since they share the walk.
- **Materialized view refused before population.** After a refused `create materialized view`, the source table is unchanged. Test this, because a refusal raised after population would leave the write behind.
- **Assertion refused at create**, and unrelated later inserts succeed because no assertion exists. Test this.
- **Write against a view inside a body** (`create view X as select * from (delete from SomeView where … returning …) d`) must also be refused, which confirms that `ViewMutation` wraps base DML nodes. Test this, or confirm by inspection and say which in the handoff.
- **Side-effecting function call in a body stays accepted.** Verify by inspection: the walk reads `nodeType`, not `physical.readonly`. No test needed.
- **Ordinary statements are unchanged**: top-level `select … from (insert … returning …)`, DML-as-insert-source, and `with`-leading data-modifying CTEs. These are already covered by `01.9-query-expr-dml.sqllogic`, `01.9.1-limit-over-dml-subquery.sqllogic` and `13.12-nested-dml-cte-rejected.sqllogic`. They must stay green.
- **Writes through a view** (`insert into V …`, `update V …`): the lowering path calls `bodyPlanningContext`, not `planViewBody`, so the check does not run there. The view-mutation suites (`93.*`, `53.1-materialized-view-write-through`) must stay green.
- **Schema unwind**: `buildCreateViewStmt` skips `validateViewBody` while `_isSchemaUnwinding()`. The new check sits inside `planViewBody`, so it is skipped too and an unwind restores the prior view exactly. No change needed. Confirm `ddl.ts` / `alter-table.ts` / `materialized-view.ts` behave the same during an unwind as they do today.
- **Catalog reload of a view persisted before this fix.** If reload replays `create view` through `buildCreateViewStmt`, such a view now fails to load, the same way a whole-body DML view would today. Backwards compatibility is not a concern yet (AGENTS.md). Find out which path reload takes and note the result in the handoff. Don't add a bypass.
- **`view_info`** (`func/builtins/schema.ts`) plans view bodies but never through `planViewBody`, so it is unaffected. Such views can no longer be created anyway.

## Docs

- docs/sql-views.md line 20: widen "A DML body … is rejected at create time" to cover DML anywhere in the body. Also state that a function with side effects is the supported way to get a view with side effects.
- docs/sql-select-cte.md § data-modifying CTEs: one sentence noting that the sibling rule for non-CTE nested DML applies only to stored bodies. In an ordinary statement a write as a subquery source stays legal.
- docs/determinism.md "Rejected in Constraints and Defaults": correct the assertion claim. Assertions are now refused at create by the stored-body check, not by the determinism enforcer.
- `building/with.ts` doc comment on `rejectNestedDataModifyingCte`: it already cites `planViewBody` as its sibling. Update that sentence to say the sibling now covers nested DML at any depth.

## TODO

- Move `DML_NODE_TYPES` from `analysis/change-scope.ts` to `nodes/plan-node-type.ts` (exported). Change-scope imports it.
- Add the stored-body write check module under `planner/building/`.
- Call it from `planViewBody` (all four stored-body DDLs) and from `planAssertionBody`.
- Add cases to `test/logic/01.9-query-expr-dml-gates.sqllogic`: view with DML from source (the SiteCAD shape: refused, and `select` from the table afterward shows no row deleted), view with DML in a scalar subquery, materialized view refused with the source unchanged, assertion refused with a later insert succeeding, and a view body writing through another view.
- Update the docs listed above.
- `yarn build`, `yarn lint`, `yarn test`. Store path: run `yarn test:store` once, since materialized-view and assertion creates touch the store module.
