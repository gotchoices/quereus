description: When "apply schema" fails partway after adding a column that carries its own CHECK rule, the automatic rollback now removes those rules before the column, so the database returns to its original shape instead of being left half-migrated.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn, constraintNamesHeld (seed + NOTE), the one call site
  - packages/quereus/src/schema/constraint-builder.ts   # extractColumnLevelCheckConstraints, now shared by the forward step and its undo
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAddColumn call site; corrected comments on what DROP COLUMN prunes
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 6
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # two new cases
  - docs/schema-undo-plan.md   # ADD COLUMN row of the undo table
repro: verified
----

# Undo of ADD COLUMN drops the column's inline CHECKs first

## What changed

The undo recorded for `ALTER TABLE t ADD COLUMN d … check (d > 0)` was only `DROP COLUMN d`, which `DROP COLUMN` refuses because a CHECK names the column. The undo now emits one `DROP CONSTRAINT` per inline CHECK, newest first, then the `DROP COLUMN`. An inline UNIQUE or foreign key needs no statement, because `shiftSchemaIndicesForDrop` removes it when the column drops, on both the memory and store backends.

The undo is SQL text computed at plan time, so the stored CHECK names have to be predicted. `UndoRenderer.dropAddedColumn` calls the same `extractColumnLevelCheckConstraints` the forward step (`runAddColumn`) calls, over a set of taken names kept per table for the whole plan and seeded from the pre-apply catalog by `constraintNamesHeld`.

`extractColumnLevelCheckConstraints` also changed shape: it adds the column's own user-written names to the taken set itself, `takenNames` is required, and the return type narrows `name` to `string`.

## Review findings

Reviewed the diff of `ticket(implement): bug-apply-undo-of-add-column-with-inline-constraint-fails` before the handoff. No defects found and no source changes made in this pass.

**Name prediction.** Compared the seed with the forward step's `collectTableConstraintNames`. Both skip unnamed entries and lowercase names. The only difference is the UNIQUEs marked `derivedFromIndex`, which `catalogConstraints` leaves out. That is the known gap below. `generateMigrationPlan`'s phase order backs the claim in `constraintNamesHeld`'s comment: constraint rename, drop and add all come after `ADD COLUMN`. Each undo closure runs once, in step order, so the shared set stays correct.

**Adversarial runs.** A throwaway spec, since deleted, ran 15 scenarios on both memory and store, using a failing `ADD constraint ub` or a failing later `ADD COLUMN`:

- a quoted column name with a space
- a differently cased `_CHECK_D` collision
- CHECK + UNIQUE + foreign key with the CHECK naming another column
- column rename + add
- table rename + name collision
- an existing `_check_d` dropped in the same plan
- a named constraint renamed in the same plan
- a second `ADD COLUMN` failing forward
- a default backfill
- a generated column with a CHECK
- a CHECK with tags
- two altered tables
- a `d_2` column beside a `d` with two CHECKs
- a named `_check_d` beside an unnamed CHECK on one column
- a non-main schema

No run produced "could not be restored". Each reported the original error, and the catalog dump matched its pre-apply state. After removing the duplicate row, a second apply succeeded in every scenario except the second `ADD COLUMN` one, whose own default violates its CHECK, so it fails the same way again.

Limits of that evidence:

- The final round ran each apply inside an explicit transaction that was then rolled back, so its row output cannot show the restore on its own. There, the proof is the engine's post-unwind catalog check and the absence of the "could not be restored" error.
- An earlier autocommit round gave the same result for 13 of the 15. The table-rename case did not parse in that round, because of a spelling mistake in the scratch spec. The generated-column case failed forward there because the column was implicitly NOT NULL, so it never reached the undo of a landed generated column.
- Those two cases therefore reached their intended undo only in the transaction round.

This also closes the handoff's store-coverage gap: the foreign key and CHECK-naming-another-column cases now restore on store.

**Tests.** Kept all three.

- Removed the line that stores the per-table set, so each call starts fresh. "an added column whose CHECK mint collides…" then fails with `Cannot drop column 'f'… '_check_f_2'`, and no other case in that spec does. It is the only coverage of the carry-over, so the handoff's offer to cut it is declined. The mutation was reverted, and `git diff` shows no content change.
- The handoff's claim that all three tests fail without the `DROP CONSTRAINT` statements was not re-run.

**Docs and comments.** Read `docs/schema-undo-plan.md`, the failure and restoration section and phase order of `docs/schema.md`, and every comment found by grepping `docs/` and the source for what `DROP COLUMN` prunes. The corrected foreign key wording in `alter-table.ts` agrees with `shiftSchemaIndicesForDrop`, with the existing comments in `schema-differ.ts` (`prunedByColumnDrop` and the note above it), and with the store run. No further doc changes needed.

**Tripwires.** Added none. The existing `NOTE:` at `constraintNamesHeld` holds the unique-index gap and its revisit condition. Confirmed from the code that `catalogConstraints` excludes derived UNIQUEs and that `CatalogIndex` declares no unique field. An index dropped earlier in the same plan is not affected, because the forward step no longer holds that name either.

**Considered and left alone.**

- `revertAddColumn`'s foreign key drop by name is redundant, as its comment now says. Removing it is unrelated cleanup.
- `constraintNamesHeld` and `constraintNamesAtAddTime` both loop over catalog names, but they answer different questions at different phases, and the second also handles drops and backing names. A shared helper would save about two lines.
- `schema-differ.ts` is 3,856 lines (`wc -l`), about 40 of them from this change. It is already tracked in `debt-oversized-source-files`, whose proposed first cut is moving `UndoRenderer` out, so no new ticket.

**Categories with nothing to report.** Resource cleanup: the change holds only a per-plan in-memory map. Performance: one set per altered table, plus a mint on a column definition that was already being parsed. Type safety: no casts or `any` added, and lint type-checks the test files.

## Known gaps

- **A unique index holding the name is still not restored.** With `create unique index _check_d` on the table, the forward step mints `_check_d_2` and the undo predicts `_check_d`. The implement stage ran this on memory: the apply reports `undo statement … DROP CONSTRAINT _check_d failed (… it is backed by index '_check_d' …)` and the column stays. That is honest, and no worse than before this fix. This review confirmed the cause by reading the code but did not re-run it.
- **The rename seed is untested through a plan.** After `rename column x to y`, a re-added `x` with a CHECK mints `_check_x_2`, but the planner cannot produce that sequence until `bug-rename-source-name-redeclared-as-new-object` lands.
- **The logic test's `-- error: ub` cannot distinguish restored from not restored**, because the wrapped message contains the original text too. The row check and the re-diff are what prove the restore.

## Validation

Run in `packages/quereus` during review, with the mutation reverted first:

- `yarn lint`: exit 0
- `yarn test`: 10872 passing, 25 pending
- `yarn test:store`: 10864 passing, 33 pending

No failures, so nothing to report as pre-existing.
