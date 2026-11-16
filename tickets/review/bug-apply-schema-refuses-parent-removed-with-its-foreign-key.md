description: A schema migration that removes a rule (a foreign key or CHECK) together with something that rule was blocking used to be refused, because the rule was removed only after the blocked step. The migration now removes such rules first, except when the declaration still refers to something it removes, where the old order keeps the refusal ahead of any data loss.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan (early constraint-drop phase), pushConstraintDrops / pushConstraintRenames, pushTableAlters + alterStageTwoItem (dropsConstraints flag), SchemaDiff.removalsStillReferenced, removalsStillReferenced(), objectsRemovedByDiff(), UndoRenderer.constraintDropLanded / constraintNamesHeld
  - packages/quereus/src/core/database.ts # _setSchemaReleasedObjects doc comment ("later" dropped)
  - docs/schema-declarative.md # Migration Order step 2 and stage 2; Redefining what a rule reads
  - docs/schema-undo-plan.md # ADD COLUMN row: taken-names set
  - docs/schema-rename-detection.md # one sentence on DROP-before-ADD
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # new cases at the end
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic # t28 plan order
  - packages/quereus/test/schema/differ-undo-plan.spec.ts # fixtures + rename-rule tests
  - tickets/backlog/bug-apply-schema-drops-parent-before-new-foreign-key-to-it-fails.md # note appended
----

## What changed

`generateMigrationPlan` now emits every table's `ALTER TABLE … DROP CONSTRAINT` in a phase of its own, after the table renames, assertion drops and `DROP MAINTAINED` detaches, and before `DROP TABLE` / `DROP VIEW` / `DROP INDEX`. It used to sit in stage 2 of `pushTableAlters`, after the object drops and after `RENAME COLUMN`. `RENAME CONSTRAINT` stays in stage 2.

The two shapes from the ticket now apply:

- A foreign key removed together with its parent table (named, unnamed inline, with its column dropped too, or re-pointed to another table): plan is `DROP CONSTRAINT pf ; DROP TABLE t`.
- A CHECK rewritten off a column that is renamed onto a context variable's name: plan is `DROP CONSTRAINT k ; RENAME COLUMN x TO who ; ADD constraint k …`.

### Deviation from the ticket: the drops do not always move

Moving every drop first broke an existing test (`50.4-declare-schema-apply-restore.sqllogic`, section 21, "The CHECK moves to a view in another schema"). That declaration rewrites CHECK `d_pc` from `d_v9` (over `d_t2`) to `temp.d_w` (also over `d_t2`) and removes `d_t2`. In the old order the old `d_pc` was still in place at `DROP TABLE d_t2` and refused it with the rows intact. Dropping `d_pc` first let `DROP TABLE` through, and then the re-add failed with `Table not found`, leaving the schema partially migrated and `d_t2`'s rows gone. The same happens for a foreign key whose body changes (for example adding `on delete cascade`) while it still points at the removed table. The ticket's claim that this change "neither causes nor fixes" that class was wrong for changed rules: their old body used to protect the drop.

Fix: a new flag `SchemaDiff.removalsStillReferenced`, set by `computeSchemaDiff` when the plan removes a table or view for good (not recreated) and either:

- `releasedDrops` came out empty, meaning a declared CHECK, DEFAULT or generated expression reaches a removed object, or the walk left the schema so the differ cannot tell; or
- a declared foreign key names a removed table.

With the flag set, the plan puts `DROP CONSTRAINT` back in stage 2, after `RENAME CONSTRAINT`, which is today's order for that plan. Such a plan usually cannot finish, and keeping the old rules in place lets the drop guards refuse before rows are lost. Docs (Migration Order step 2) describe this as the one exception.

Reviewer questions:

- Is a plan-wide flag the right granularity? A per-constraint rule ("hold only the changed constraints whose new body may reach a removed object") is more precise but needs pairing drops with their re-adds. In the flagged case the plan fails anyway, so precision only matters for the case the differ cannot decide (a walk leaving the schema), where the flag falls back to today's behaviour.
- The flag is not rendered by `diff schema`; only the order it produces is.

### Undo renderer

`UndoRenderer.constraintNamesHeld` used to assume no constraint phase came before `ADD COLUMN`. Now `pushConstraintDrops` calls `constraintDropLanded(table, name)`, which seeds the per-table taken-names set if needed and removes the dropped name. Without that, a user-named `_check_e` removed while a new column `e` with an unnamed inline CHECK is added would mint `_check_e` forward and predict `_check_e_2` in the undo. In the held order a table's drops follow all its `ADD COLUMN` steps, so the removal changes nothing there. `readdConstraint` is unchanged: at the early position only table renames are in force, so the restored body keeps pre-rename column names, which is right because the column renames are undone first.

## Tests

Added or changed, each with what it verifies:

- `50-declarative-schema.sqllogic` (end of file):
  - A kept foreign key still refuses removing its parent (`still has rows referencing it`), and the parent's row survives. The ticket asked for this; nothing pinned it before.
  - A changed foreign key still pointing at the removed parent is refused the same way. This pins the foreign-key arm of `removalsStillReferenced`. I checked it fails with that arm disabled (the drop goes through and the re-add fails).
  - The ticket's repro: foreign key and parent removed together. `diff schema` shows `DROP CONSTRAINT` before `DROP TABLE`, the apply succeeds, and the child keeps its row.
  - The ticket's CHECK + `RENAME COLUMN` onto a context variable repro: plan order is pinned, the apply succeeds, and the new CHECK is enforced.
- `differ-undo-plan.spec.ts`:
  - New round trip "an added column whose CHECK mint takes a name the plan dropped before it". This is the `constraintDropLanded` regression; with the call disabled it fails with `Named constraint '_check_e_2' not found`.
  - New "when the declaration still reads a view it removes, the drops wait for stage 2 …". It pins the held order and Rule 2 replay, for the owning table's column rename and another table's. This took over from the old cross-table test.
  - Rewritten for the new order: "a constraint dropped before the column it names is renamed …" (body keeps `qty`), "UNIQUE and FK column lists keep their pre-rename names, and the FK parent follows the table rename", and "a CHECK with a qualified self-reference follows the table rename, and not the later column rename".
  - Removed: the round trip "another table's column rename with a cross-table CHECK subquery dropped (the non-owning walk)". In the new order it duplicates the single-table round trip. The held-order string test above now covers the non-owning walk. Retitled the other round trip to drop "(Rule 2)".
  - Broad fixtures `BROAD_DDL_MAIN` / `BROAD_DDL_ANALYTICS`: `DROP CONSTRAINT ck_stale` moved to just after `DROP MAINTAINED`.
- `50.2-declare-schema-renames.sqllogic` section 28: expected plan order updated (drop before rename).

Not changed: about 20 test files mention `DROP CONSTRAINT`, but only the ones above pinned an order that moved.

## Validation run

- `yarn workspace @quereus/quereus lint`: clean.
- Full quereus mocha suite without `--bail`: 11201 passing, 26 pending, 0 failing.
- `yarn test:store`: 11194 passing, 33 pending, 0 failing.

## Known gaps

- The held order keeps whatever today's order does for a plan the differ cannot judge. That includes refusing a plan whose cross-schema CHECK walk would not really reach a removed object, as today.
- A foreign key that is new in the declaration and names a removed table still drops the table first and then fails. That is backlog `bug-apply-schema-drops-parent-before-new-foreign-key-to-it-fails`; I appended a note that the new flag identifies that shape.
- `diff schema` run by hand still fails for a DEFAULT, or a kept CHECK read through a redefined view, that reaches a removed object. Docs § Redefining what a rule reads now scope that limit to those cases.
