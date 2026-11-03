description: When "apply schema" fails partway, the automatic rollback could be refused by the safety checks that protect ordinary drops, leaving the database half-migrated. The rollback now gets past those checks, because it is returning to a known earlier state and verifies that afterwards.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding / _isSchemaUnwinding
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # unwindJournal, new runJournalInReverse sets the scope
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # refuseColumnExpressionDependent, assertNoForeignKeyReferencesColumn; header comment
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts   # assertNoExpressionDependsOn
  - packages/quereus/src/schema/manager.ts   # assertNoReferencingChildrenForDrop
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn: comment only
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # sections 7 and 8; section 6 comment reworded
  - packages/quereus/test/schema-batch-hook.spec.ts   # refused-commit case
  - docs/schema-undo-plan.md   # new "Guards during an unwind"; ADD COLUMN row
repro: verified
----

# A rollback is no longer refused by guards meant for user-issued drops

## What changed

`CREATE TABLE` does not check what its foreign keys and CHECK / DEFAULT subqueries refer to, so a table the plan creates can refer to a column, table or view that a later step adds. The undo journal runs in exact reverse, so it removed that target while the referring table still existed, and the guard on `DROP COLUMN`, `DROP TABLE` or `DROP VIEW` refused. The unwind stopped and the apply reported "partially migrated".

`Database` now has an internal scope, `_setSchemaUnwinding`, modelled on `_setFkRestrictSuppressed`: the setter returns the prior value and the caller restores it in a `finally`. `unwindJournal` splits its statement loop into `runJournalInReverse`, which holds the scope, so the fingerprint check runs outside it. Both failure paths (a failed step and a refused commit) go through `unwindJournal`.

Inside the scope these return early, each checked inside the guard so callers did not change:

- `refuseColumnExpressionDependent` (the DEFAULT / generated and CHECK guards on `DROP COLUMN`)
- `assertNoForeignKeyReferencesColumn`
- `assertNoExpressionDependsOn` (`DROP TABLE`, `DROP VIEW`, `DROP MATERIALIZED VIEW`)
- `assertNoReferencingChildrenForDrop`

These stay on: the assertion guards, and the other `runDropColumn` validations (primary key, last column, own generated column, partial index). `dropAddedColumn` still emits `DROP CONSTRAINT` for inline CHECKs, because the module's `DROP COLUMN` does not prune them; only the stated reason changed. The fingerprint comparison is the backstop for a wrong undo.

## Tests added

Run on memory and store unless noted.

- `50.4` section 7: new tables holding forward references to an added column (FK, CHECK subquery, DEFAULT subquery), a later new table, and a new view. The apply restores, then applies once the duplicate row is fixed, and the references resolve. The trailing `drop view v` proves the guards are back on after the failure.
- `50.4` section 8: references already dangling before the apply, an existing table's CHECK naming `t.d` and an existing table's FK to `zz` with rows. Both return to their dangling state.
- `schema-batch-hook.spec.ts`, "the unwind gets past a guard that refuses a user drop of the added column": a refused commit where the unwind has to pass the FK guard. Memory only.

Mutation check, run on memory against section 7/8 plus the spec case: putting each of the four guards back on, one at a time, failed a test, and so did removing the scope's `finally` restore. These were temporary edits, since reverted.

## Validation

- `yarn test`: all workspaces passing (quereus 10884).
- `yarn lint`: clean.
- `50.4` with `QUEREUS_TEST_STORE=true`: passing. After that full run, the now-unneeded `pragma foreign_keys` wrapping section 8's final drops was removed, and only `50.4` was re-run, on memory and store.
- `yarn test:store` was run on the restore logic file only, as the ticket asked, not over the whole logic suite.

## Known gaps for the reviewer

- **The assertion guard has no permanent test.** A scratch run on memory gave it its first exercise: a refused commit over a new assertion reading an added column restored with the guard on, because `DROP ASSERTION` runs first. The claim that an assertion cannot hold a forward reference still rests on reading the code.
- **Scratch-only shapes, memory only, all restored, no permanent test:** an added UNIQUE or new unique index plus a new FK to it, a primary key change plus a new FK to the new key, a new materialized view read by a new table's CHECK, the `t.d` / `n` mutual FK, and a dependent in the `temp` schema. So `DROP CONSTRAINT`, `DROP INDEX` and `ALTER PRIMARY KEY` undo were not refused in these shapes, but no code asserts that they never are.
- **The scope covers every drop inside the unwind, including the internal `DROP TABLE` of a shadow rebuild** when undoing `ALTER PRIMARY KEY` on a backend that cannot re-key in place. Its assertion guard is still on, so that case stays with `bug-rebuild-drop-refused-by-user-facing-guards`. This interaction was not run. That ticket should decide whether to share this scope; it was deliberately not widened.
- **A dependent in another schema is outside the fingerprint.** This plan cannot have created one, so it is treated as the already-dangling case, and the docs say so.

## Usage

There is nothing new to call. A migration such as the one below now fails with the step's own error and leaves the catalog as it was:

```sql
create table t (id integer primary key, b integer null);
insert into t values (1, 1), (2, 1);
declare schema main {
	table t { id integer primary key, b integer null, d integer null unique, constraint ub unique (b) }
	table n { id integer primary key, x integer null references t(d) }
}
apply schema main;   -- error naming ub; n and t.d are gone
```
