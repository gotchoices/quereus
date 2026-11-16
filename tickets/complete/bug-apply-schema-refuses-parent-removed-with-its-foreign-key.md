description: A schema migration that removes a rule (a foreign key or CHECK) together with something that rule was blocking used to be refused, because the rule was removed only after the blocked step. The migration now removes such rules first, except when the declaration still refers to something it removes, where the old order keeps the refusal ahead of any data loss.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan (early constraint-drop phase), pushConstraintDrops / pushConstraintRenames, pushTableAlters + alterStageTwoItem (dropsConstraints flag), SchemaDiff.removalsStillReferenced, removalsStillReferenced(), objectsRemovedByDiff(), UndoRenderer.constraintDropLanded / constraintNamesHeld
  - packages/quereus/src/core/database.ts # _setSchemaReleasedObjects doc comment
  - docs/schema-declarative.md # Migration Order step 2 and stage 2; Redefining what a rule reads
  - docs/schema-undo-plan.md # ADD COLUMN row: taken-names set
  - docs/schema-rename-detection.md
  - packages/quereus/test/logic/50-declarative-schema.sqllogic
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic
  - packages/quereus/test/schema/differ-undo-plan.spec.ts
----

## What landed

`generateMigrationPlan` emits every table's `ALTER TABLE … DROP CONSTRAINT` in its own phase, after table renames, assertion drops and `DROP MAINTAINED`, and before `DROP TABLE` / `DROP VIEW` / `DROP INDEX` and every column change. `RENAME CONSTRAINT` stays in stage 2 of the table alters. So a foreign key removed together with its parent table, and a CHECK rewritten off a column that is renamed onto a context variable's name, now apply.

Exception: when `computeSchemaDiff` sets `SchemaDiff.removalsStillReferenced` (the plan removes a table or view for good and either releases no drop — a declared rule reaches a removed object or walks into another schema — or a declared foreign key names a removed table), the drops stay in stage 2 after `RENAME CONSTRAINT`, the old order. That keeps a changed rule's old body in place so it refuses the object drop before rows are lost, instead of the re-add failing after `DROP TABLE` ran (found through `50.4-declare-schema-apply-restore.sqllogic` section 21).

`UndoRenderer.constraintDropLanded` frees a dropped name from the per-table taken-names set, so an `ADD COLUMN` CHECK mint after an early drop is predicted correctly in the undo. Early drops' undo re-adds bodies with pre-rename column names and post-rename table names, which is what the catalog holds at unwind time.

See the implement commit `ticket(implement): bug-apply-schema-refuses-parent-removed-with-its-foreign-key` for the full change and test list.

## Review findings

**Checked:**

- Read the implement diff (`schema-differ.ts`, `database.ts`, three docs, three test files, backlog note) before the handoff.
- Ordering of the new phase against everything before and after it: table renames (the drop's `quotedAlterTable` uses post-rename names, and the undo renderer has table renames in force), `DROP MAINTAINED` (still precedes), `DROP INDEX` (now after the constraint drops; no constraint depends on a standalone index, and index-derived UNIQUEs are not in `constraintsToDrop`), `ALTER COLUMN` retypes (an old CHECK no longer judges a retype, which only removes refusals), `RENAME CONSTRAINT` onto a dropped name, `ALTER PRIMARY KEY`, `ADD CONSTRAINT`, `DROP COLUMN` (stage 4, still after). No ordering regression found.
- `removalsStillReferenced`: `releasedDrops` is only empty with a non-empty removal set when a rule reaches a removed object or a walk leaves the schema (read `dropsReleasedByDeclaration`); `foreignKeyParents` covers inline and table-level foreign keys; only declared tables are scanned, so a removed child's own foreign key does not trigger the flag; recreated objects are excluded. Called after `releasedDrops` is assigned, and `computeSchemaDiff` has no earlier return that skips it.
- Undo: `constraintNamesHeld` seeding with early drops, and in held order (drops follow the table's `ADD COLUMN`, so removal there is harmless).
- Probed by script (not kept as tests): a rewritten CHECK plus a column rename whose new CHECK fails existing rows restores fully (old `ck check (qty > 0)` back and enforced); a foreign key removed with its parent plus a later failing step reports partially migrated with the parent gone. That is the documented residual for any plan with a `DROP TABLE` (docs/schema-declarative.md § Failure and restoration), and is the intended consequence of no longer refusing the drop.
- Docs: read Migration Order, Redefining what a rule reads, the undo-plan table and the rename-detection paragraph; all match the new order. Grepped docs for other statements of the old order (`RENAME CONSTRAINT then DROP CONSTRAINT`): none left.
- Tests: the new sqllogic cases pin the ticket's two repros, the kept-FK refusal and the changed-FK arm of the flag; the spec cases pin the held order with its undo and the mint regression. Each covers a distinct behaviour; nothing restates the implementation or mocks the repository's own modules, so none were cut. No tests added.
- `yarn workspace @quereus/quereus lint`: clean. Full quereus suite: 11201 passing, 26 pending, 0 failing. (`yarn test:store` was run by the implementer; this review changed only a comment and a doc sentence, so it was not re-run.)

**Found and fixed (minor):**

- docs/schema-declarative.md Migration Order step 2 described the exception only as "a rule reaches the removed object"; the flag also fires when a rule's walk reaches another schema and the differ cannot tell. Added that clause.

**Tripwire (parked, not filed):**

- The flag is plan-wide: one declared CHECK anywhere whose subquery reads another schema holds every constraint drop, so a foreign key removed together with its parent is refused as before even when that CHECK is unrelated. Confirmed by script. Parked as a `NOTE:` on `removalsStillReferenced` in `schema-differ.ts`, with the per-constraint narrowing as the revisit path. It falls back to the pre-change behaviour, so it is not a regression.
- Considered: the foreign-key arm also fires for a *kept, unchanged* foreign key naming a removed table, which holds drops that need no holding. Only matters when that kept key has no referencing rows (otherwise the plan is refused at the drop anyway) and a second removal depends on an early drop; contrived, and the declaration itself is broken there. Not recorded beyond this line.

**Major findings:** none. The one remaining known shape (a foreign key new in the declaration naming a removed table) is already backlog `bug-apply-schema-drops-parent-before-new-foreign-key-to-it-fails`, with the implementer's note appended.

**Size:** `schema-differ.ts` is 4,481 lines (`wc -l`, was 4,414 before the implement commit). Already tracked by backlog `debt-oversized-source-files`; updated its measurement line rather than filing anew.
