description: When "apply schema" removes a view or a table's maintained definition and then fails, the rollback recreates it as if it were new, so it is refused if the object was already broken or its rows would not pass a fresh check, and the database is left half-migrated. The rollback should put the object back without judging it.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/planner/building/create-view.ts   # buildCreateViewStmt plans the body (planViewBody) at build time: skip during an unwind
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation → validateDeclaredConstraintsOverContents: skip during an unwind
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring lists what stands down
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.recreateView / reattachAsBefore / undoSetMaintained (read only, no change expected)
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # runJournalInReverse holds the unwind flag around each undo statement (read only)
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # add a section for the view and maintained cases
  - packages/quereus/test/apply-schema-restore.spec.ts   # the cross-schema view chain (sqllogic cannot easily build it)
  - docs/schema-undo-plan.md
repro: verified
----

# A rollback's recreated view or maintained definition is judged as if it were new

This is the same kind of failure as `bug-apply-undo-refused-when-re-added-constraint-does-not-validate`, which is complete. That ticket made an `ADD CONSTRAINT` issued during an unwind stop judging the constraint. This one applies the same rule to the two other undo statements that recreate an object: `CREATE VIEW` (the undo of `DROP VIEW`) and `ALTER TABLE … SET MAINTAINED AS` (the undo of `DROP MAINTAINED`, and of a same-shape re-attach).

The rule from `docs/schema-undo-plan.md` § Guards during an unwind: an unwind returns to the pre-apply state, which already existed, so it judges nothing. A refusal there only leaves the schema partially migrated.

## Reproduction (memory backend, all verified)

Common start: `create table t (id integer primary key, b integer null); insert into t values (1, 1), (2, 1);`. Each declaration adds `constraint ub unique (b)` to `t`, which fails forward, and drops the object below. Today each ends in "The schema is partially migrated and could not be restored".

- **View that no longer compiles.** `create table g (id integer primary key); create view v as select id from g; drop table g;`. Declare only `t`. Undo `create view v as select id from g` fails with `Table 'g' not found in schema path: main`.
- **Maintained table whose rows break its foreign key.** `create table p (id integer primary key); create table src (id integer primary key, x integer null); insert into src values (1, 99); create table m (id integer primary key, x integer null, constraint c foreign key (x) references p(id)); pragma foreign_keys = off; alter table m set maintained as select id, x from src; pragma foreign_keys = on;`. Declare `t`, `p`, `src` and `m` as a plain table with the same columns and constraint. Undo `alter table m set maintained as select id, x from src` fails with `FOREIGN KEY constraint failed: c — row derived into maintained table 'main.m' references a missing 'main.p'`.
- **View chain through another schema.** `declare schema s { table T { Id integer primary key, N integer } view V1 as select Id, N as S from T }`, `apply schema s`, `insert into s.T values (1, 10)`, `create view main.M as select S from s.V1`, `create view s.V3 as select S as D from main.M`. Then declare `s` with `T`, `V1 as select Id, N + 1 as S from T`, `V3 as select S + 0 as D from main.M` and `view Bad as select * from nothere`. The forward step `create view s.Bad` fails. The differ only sees schema `s`, so it drops `V1` before `V3`, and the undo `create view s.V3 …` is planned while `s.V1` is still gone, so it fails. After the fix, `select D from s.V3` returns `[{ D: 10 }]` and the step's own error is reported.

## Cause (confirmed with a temporary patch)

- **Views.** `buildCreateViewStmt` (`planner/building/create-view.ts`) always plans the body through `planViewBody`, both to check the explicit column list's arity and to reject a DML body. The undo statement is planned inside `runJournalInReverse`, where `db._isSchemaUnwinding()` is true. The emitter (`runtime/emit/create-view.ts`) does not compile the body again, and nothing on `view_added` does either.
- **Maintained tables.** `attachMaintainedDerivation` (`runtime/emit/materialized-view-helpers.ts`) calls `validateDeclaredConstraintsOverContents` after the reconcile. That function scans the table's CHECKs (insert or update op-mask) and child-side foreign keys over the derived rows. It is the only judgement of the table's own constraints on the attach path. Its CHECK arm was not run in the probe; it is the same function, so the same skip covers it.

A temporary patch that skipped both during an unwind made all three reproductions restore and report `ub`'s own error. Removing the view half alone made the chain case fail again.

## Fix

- In `buildCreateViewStmt`, skip `planViewBody` (both branches) when `ctx.db._isSchemaUnwinding()`. The body came from the pre-apply catalog, so it is not a DML body and its column list matched it when it was created. The view is stored exactly as it was, broken or not.
- In `attachMaintainedDerivation`, skip `validateDeclaredConstraintsOverContents` when `db._isSchemaUnwinding()`. Leave everything else in place: the body still has to compile, because the reconcile derives the rows from it, and the shape, derivation-cycle and row-set (`assertDerivedRowsAreSet`) checks are structural. The reconcile is `replace-all` by diff. The table's rows were not touched by the `DROP MAINTAINED` (catalog-only on memory; the store moves them back to ordinary storage), so for an unchanged source the diff is empty and no write goes through a UNIQUE check.
- Comment each skip with the same wording style as the existing stand-downs (`add-constraint.ts` `rejectCheckViolatedByExistingRows`, `drop-column-guards.ts`).
- Update the `_setSchemaUnwinding` docstring in `core/database.ts` and the bullet list in `docs/schema-undo-plan.md` § Guards during an unwind: add "a recreated view's body is not planned" and "a re-attached derivation's declared CHECKs and foreign keys are not scanned".

## Things to check while there (not observed)

- `db.registerMaterializedView` inside the attach runs create-time gates, including the full-rebuild size threshold (`materialized_view_rebuild_row_threshold`, `core/database-materialized-views-plan-builders.ts` around line 1327). A source that grew past the threshold after the maintained table was created could refuse the re-attach on undo. If it is easy to reach, stand that gate down during an unwind too; if not, leave a `NOTE:` tripwire at the gate.
- A maintained table whose body no longer compiles cannot be re-attached on undo, because the rows are derived from it. Check whether that pre-apply state is reachable at all (drops of a maintained table's source are guarded). If it is, record it as a `NOTE:` and a line in the doc, not a fix here.
- Run the maintained case under `yarn test:store` too; the store's `retireBackingForAttach` / `ensureBackingForAttach` pair runs on that route.

## Tests

One reproduction each, no more:

- `50.4-declare-schema-apply-restore.sqllogic`: a new section with the broken view and the maintained table with an orphan row, both in one declaration that fails on `ub`. Assert the error names `ub`, then `diff schema main` shows the plan again (the `drop view v` and the `drop maintained` steps are back), and `select * from m` still returns the orphan row. This runs on both backends.
- `apply-schema-restore.spec.ts`: the cross-schema view chain above, asserting the step's own error and `select D from s.V3`.

## TODO

- Skip `planViewBody` in `buildCreateViewStmt` during an unwind, with a comment.
- Skip `validateDeclaredConstraintsOverContents` in `attachMaintainedDerivation` during an unwind, with a comment.
- Check the rebuild-threshold gate and the uncompilable-body case described above; fix the first or leave `NOTE:`s.
- Add the sqllogic section and the spec case.
- Update `_setSchemaUnwinding`'s docstring and `docs/schema-undo-plan.md`.
- `yarn build`, `yarn lint`, `yarn test`, and `yarn test:store`.
