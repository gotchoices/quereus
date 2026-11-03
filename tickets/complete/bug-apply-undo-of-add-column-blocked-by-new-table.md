description: When "apply schema" fails partway, the automatic rollback could be refused by the safety checks that protect ordinary drops, leaving the database half-migrated. The rollback now gets past those checks, because it is returning to a known earlier state and verifies that afterwards.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding / _isSchemaUnwinding
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # unwindJournal, runJournalInReverse sets the scope
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # expression, foreign key and assertion guards; header comment
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts   # assertNoExpressionDependsOn
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts   # assertNoAssertionDependsOn
  - packages/quereus/src/schema/manager.ts   # assertNoReferencingChildrenForDrop
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn: comment only
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # sections 7, 8 and 9
  - packages/quereus/test/schema-batch-hook.spec.ts   # refused-commit case
  - docs/schema-undo-plan.md   # "Guards during an unwind"; ADD COLUMN row
repro: verified
----

# A rollback is no longer refused by guards meant for user-issued drops

## What changed

`CREATE TABLE` does not check what its foreign keys and CHECK / DEFAULT subqueries refer to, so a table the plan creates can refer to a column, table or view that a later step adds. The undo journal runs in exact reverse, so it removed that target while the referring table still existed, and the guard on `DROP COLUMN`, `DROP TABLE` or `DROP VIEW` refused. The unwind stopped and the apply reported "partially migrated".

`Database` now has an internal scope, `_setSchemaUnwinding`, modelled on `_setFkRestrictSuppressed`. `unwindJournal` splits its statement loop into `runJournalInReverse`, which holds the scope, so the fingerprint check runs outside it. Both failure paths (a failed step and a refused commit) go through `unwindJournal`.

Inside the scope every reference guard on the drop path returns early: `refuseColumnExpressionDependent`, `assertNoForeignKeyReferencesColumn`, `assertNoAssertionNamesColumn`, `assertNoExpressionDependsOn`, `assertNoAssertionDependsOn` and `assertNoReferencingChildrenForDrop`. The assertion pair was added in review (see below).

The other `runDropColumn` validations (primary key, last column, own generated column, partial index) stay on. `dropAddedColumn` still emits `DROP CONSTRAINT` for inline CHECKs, because the module's `DROP COLUMN` does not prune them. The fingerprint comparison is the backstop for a wrong undo.

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

## Review findings

**Read:** the `ticket(implement): bug-apply-undo-of-add-column-blocked-by-new-table` diff before the handoff, then the guards, `unwindJournal`, `_execWithinTransaction`, and `docs/schema.md`, `docs/schema-undo-plan.md`, `docs/sql-alter.md`, `docs/schema-rename-detection.md`.

**Found and fixed in this pass: the assertion guards also blocked the rollback.** The handoff and the fix-stage ticket both said an assertion cannot hold a forward reference, from reading code only. That is false: an existing assertion can come to name what the plan added without being edited. All three shapes below reported "could not be restored" on memory before the fix:

- a bare name captured by an added column: `select 1 from u where exists (select 1 from t where t.id = u.id and d < 0)`, where `d` means `u.d` until `t` gains a `d`;
- an explicit column list over a star: `create view v (x, y) as select * from t`, with an assertion over `v`;
- a name captured by a new table: an assertion's `zz` resolving to `temp.zz` under `pragma schema_path = 'main,temp'`, then the plan adds `main.zz`.

Both assertion guards now stand down too. Docs and comments now state the third reason a reference may break during an unwind: it goes back to what it named before the apply. Added section 9 of `50.4` (first and third shapes, one per guard function), passing on memory and store. Mutation check on memory: removing either new early return fails section 9. After the fix the second shape was not re-run; it stops at the same early return as the first.

**Filed:**

- `bug-apply-schema-loses-rows-after-rebuild-when-later-step-fails` (corruption, unusual; verified): on a backend with no in-place re-key, a primary key change followed by a failing step leaves the table empty while reporting an ordinary failure. The shape has nothing for these guards to refuse, so it should predate this ticket; that is inferred, not run at the earlier commit. Memory keeps its rows in the same scenario.
- `bug-apply-undo-refused-when-re-added-constraint-does-not-validate` (wrong-result, unusual; verified): the undo of `DROP CONSTRAINT` is a validating `ADD`, so it is refused when rows no longer satisfy a subquery CHECK, when a CHECK already dangled, or when rows violate a foreign key. This is a different mechanism from the drop guards and also involves a module's own scan, so it was not widened into this pass. `docs/schema-undo-plan.md` states the limitation.

**Updated:** the Related note in `bug-rebuild-drop-refused-by-user-facing-guards`, which said this scope leaves the assertion guards on. That ticket also touches `rebuildViaShadowTable`, but its defect (a refused drop) is separate from the row loss filed above, so the two stay separate.

**Checked, no defect:**

- Scope lifetime: restored in a `finally`, and section 7's trailing `drop view v` shows the guards are back on after a failure. `_execWithinTransaction` takes no mutex and runs under the apply's, per its own doc comment.
- The validations left on: a partial index or own generated column naming a missing column is refused when created, so neither can hold a forward reference (scratch run, memory).
- Scratch runs on memory, all restored: an existing child foreign key dangling onto an added column, with rows; an assertion over a plain star view; an assertion over `select *`; a CHECK reading an explicit-list star view; an assertion with a bare `d` in a join.
- The handoff's gap on the shadow rebuild under the scope: a primary key change with a foreign key child and rows reported a matching catalog, but it exposed the row loss filed above. In the one shape run with an expression dependent, the forward rebuild was refused by the same guard, so the undo was never reached there. No shape was found where only the undo is refused; this was not exhaustive.
- Row guard comment in `manager.ts` ("a table this apply created"): accurate, since the rebuild's internal drop returns earlier on the foreign key suppression flag.

**Tests:** kept the implementer's sections 7 and 8. Kept the `schema-batch-hook` refused-commit case: the fix-stage ticket asked for it and it uses real modules, although the scope is shared by both paths, so it is the closest of these to testing wiring. Cut nothing.

**Tripwires parked:** none new. A dependent in another schema remains outside the fingerprint, as `docs/schema-undo-plan.md` already says.

**Hygiene, types, performance:** no findings. The early returns add one boolean read per guard call. The scratch spec was deleted.

**Validation:** `yarn lint` exit 0. `packages/quereus` tests 10884 passing, 25 pending, exit 0, run after the fix. `yarn test` across the other workspaces showed no failures, read from its output rather than an exit code. `50.4` passed with `QUEREUS_TEST_STORE=true`. The full store suite was not run, only that file, as the ticket asked.
