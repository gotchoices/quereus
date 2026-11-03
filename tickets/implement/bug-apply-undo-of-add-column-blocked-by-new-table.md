description: When "apply schema" fails partway, the automatic rollback can be refused by the safety checks that protect ordinary drops, because a table the same migration created refers to something the rollback must remove. The database is then left half-migrated; the rollback should get past those checks, since it is returning to a known earlier state and verifies that afterwards.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # unwindJournal: set the scope around the statement loop
  - packages/quereus/src/core/database.ts   # new scope flag, beside _setFkRestrictSuppressed (~2799)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # refuseColumnExpressionDependent, assertNoForeignKeyReferencesColumn; header comment
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts   # assertNoExpressionDependsOn (DROP TABLE, DROP VIEW)
  - packages/quereus/src/schema/manager.ts   # assertNoReferencingChildrenForDrop (~1481)
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn: comment only
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # new section, runs on both backends
  - docs/schema-undo-plan.md   # Restoring a failed apply; ADD COLUMN row
repro: verified
----

# A rollback is refused by guards meant for user-issued drops

## Root cause

`CREATE TABLE` does not check what its foreign keys and CHECK / DEFAULT subqueries refer to, so a new table may refer to a column, table or view that does not exist yet. The migration plan creates tables first, so these forward references are accepted. The undo journal runs in exact reverse, so the referenced object is removed while the referring table still exists, and the guard on `DROP COLUMN`, `DROP TABLE` or `DROP VIEW` refuses. The unwind stops, and the apply reports "partially migrated".

The guards exist so a user's drop cannot break a working reference. In an unwind that reason does not apply, because the target state is the pre-apply catalog. Any reference the undo leaves dangling for a moment either belongs to an object a later undo removes or was already dangling before the apply. `unwindJournal` then compares the catalog with its pre-apply rendering, so a wrong result is still reported.

## Reproduced

Memory, HEAD 3f2606d87. Start from `table t { id integer primary key, b integer null }` with rows `(1, 1), (2, 1)`. Every declaration also adds `constraint ub unique (b)` to `t`, which fails forward. Each shape below ended in "could not be restored":

| what the declaration adds | refused undo statement |
|---|---|
| `t.d` + new table with FK `references t(d)` (the ticket's first report) | `ALTER TABLE t DROP COLUMN d` |
| `t.d` + new table with inline or table-level CHECK reading `t.d` through a subquery (second report) | `ALTER TABLE t DROP COLUMN d` |
| `t.d` + new table with DEFAULT reading `t.d` through a subquery | `ALTER TABLE t DROP COLUMN d` |
| `t.d references n(id)` + new `n` with FK `references t(d)` (a mutual reference) | `ALTER TABLE t DROP COLUMN d` |
| new table `aa` with CHECK reading new table `zz`, declared later | `DROP TABLE IF EXISTS zz` |
| new table with CHECK reading a new view | `DROP VIEW IF EXISTS v` |
| a table that exists before the apply, with a dangling FK to `zz`, and rows; new `zz` | `DROP TABLE IF EXISTS zz` (the row guard) |

An existing table with a dangling CHECK or FK naming `t.d` is the same shape. It was only run with the prototype below, where it restored.

**The altered-table question the original ticket left open is settled: it is not this bug.** With `u` altered ahead of `t`, `ALTER TABLE u ADD constraint … references t(d)` is refused forward (`Referenced column 'd' not found in table 't'`), as are the CHECK-subquery, inline-FK and DEFAULT-subquery spellings. The failure restores cleanly. These `ALTER` forms validate their references and `CREATE TABLE` does not, and of the shapes run only `CREATE TABLE` created a forward reference. The forward refusal is filed as `bug-apply-schema-alters-tables-in-declaration-order`.

## Fix

Add an internal scope on `Database`, modelled on `_setFkRestrictSuppressed`: a setter that returns the prior value, restored in a `finally`. The apply already holds the statement mutex, so no other statement can observe the flag. `unwindJournal` sets it around its statement loop only, not the fingerprint check. Both callers go through `unwindJournal`: the failed step and the refused batch end.

These guards stand down inside the scope, each checked inside the guard so its callers do not change:

- `refuseColumnExpressionDependent` (the DEFAULT / generated and CHECK guards on `DROP COLUMN`)
- `assertNoForeignKeyReferencesColumn`
- `assertNoExpressionDependsOn` (`DROP TABLE`, `DROP VIEW`)
- `assertNoReferencingChildrenForDrop`

These stay on:

- **The assertion guards.** `CREATE ASSERTION` plans its body when it runs and assertions are created last, so an assertion should not be able to hold a forward reference, and its undo runs before any table or column undo. This is from reading the code, not a test: the scratch run of a new assertion over an added column failed before the assertion was created, so it never exercised these guards.
- **The other `runDropColumn` validations.** These are the primary key, last column, own generated column and partial index checks, all structural to the altered table and undone in order.

`dropAddedColumn` must keep emitting `DROP CONSTRAINT` for inline CHECKs. With the guard off, `DROP COLUMN` would no longer refuse, but the CHECK would survive and the fingerprint check should report the mismatch. Its comment and the `ADD COLUMN` row of the undo table say the statements exist because `DROP COLUMN` refuses, so both need rewording.

`renderCatalogForRestoreCheck` renders only the applying schema. A dependent in another schema is outside the fingerprint, but this plan cannot have created it, so it is the pre-existing dangling case and returns to the state it was in.

## Prototype evidence

A throwaway version (a global flag per undo statement, since reverted) was run:

- All the shapes above restored on memory, with the catalog rendering matching.
- `apply-schema-restore`, `schema-batch-hook`, `ddl-schema-event-atomicity` and `differ-undo-plan` specs passed (110 tests), as did `50.4` on memory and store.
- The scenario under TODO restored and then applied on memory and store.

Not run: the full test suite, and a refused batch end that hits one of these guards. The pre-existing-dangling shapes ran on memory only.

## Alternatives rejected

- **Reordering the plan so `ADD COLUMN` precedes creates.** `ADD COLUMN … references` refuses a missing parent column (verified with a missing column; a missing table was not run), so this would likely break `t.d references n(id)` with a new `n`, which works today. The mutual-reference shape has no valid order at step granularity, and a pre-existing dangling reference is not an ordering problem at all.
- **Dropping the referring new table inside the `ADD COLUMN` undo.** `DROP … IF EXISTS` would make the later undo harmless, but the planner would have to duplicate the guards' reference analysis, and the drop can itself be blocked by a step not yet undone.
- **Deferring `DROP COLUMN` to the end of the unwind.** This breaks Rule 1 of the undo plan: a rename undone in between changes the spelling of the deferred statement, and rename-then-re-add needs the drop first.

## Related

`bug-rebuild-drop-refused-by-user-facing-guards` (backlog) proposes a similar scope for the `ALTER PRIMARY KEY` shadow rebuild. It also needs the assertion guard off, so it is not the same set. Do not widen this scope for it. Name this one for the unwind and leave that ticket to decide whether to share it.

## TODO

- Add the scope to `Database`, set it in `unwindJournal`, and honour it in the four guards above.
- Add a section to `50.4-declare-schema-apply-restore.sqllogic` from this scenario, which passed on both backends under the prototype. The trailing `drop view v` proves the guards are back on after the failure:

```sql
create table t (id integer primary key, b integer null);
insert into t values (1, 1), (2, 1);

declare schema main {
	table t { id integer primary key, b integer null, d integer null unique, constraint ub unique (b) }
	table n { id integer primary key, x integer null references t(d), y integer null check (y > (select max(d) from t)), z integer null default ((select max(d) from t)) }
	table aa { id integer primary key, x integer null check (x > (select max(id) from zz)) }
	view v as select id from t
	table k { id integer primary key, x integer null check (x > (select max(id) from v)) }
	table zz { id integer primary key }
}
-- apply fails naming ub; t keeps its rows; n and zz are not found.
-- update t set b = 2 where id = 2; apply succeeds.
-- insert into t (id, b, d) values (3, 3, 30); insert into n (id, x, y) values (1, 30, 31);
-- select id, x, y, z from n gives {1, 30, 31, 30}.
-- drop view v; errors naming k.
```

- Add the pre-existing-dangling cases (an existing table's CHECK naming `t.d`; an existing table's FK to `zz` with rows, `pragma foreign_keys` off for the insert), and confirm they restore on store.
- Add one refused-batch-end case to `test/schema-batch-hook.spec.ts` where the unwind has to get past a guard.
- Update `docs/schema-undo-plan.md` § Restoring a failed apply: which guards stand down, why, and that the fingerprint is the backstop. Reword the `ADD COLUMN` row, the `dropAddedColumn` comment, and the `drop-column-guards.ts` header, whose rationale assumes every drop is user-issued.
- Run `yarn test`, `yarn test:store` on the restore logic file, and `yarn lint`.
