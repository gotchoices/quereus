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

The undo recorded for `ALTER TABLE t ADD COLUMN d … check (d > 0)` was only `DROP COLUMN d`, which `DROP COLUMN` refuses because a CHECK names the column. The undo now emits one `DROP CONSTRAINT` per inline CHECK, newest first, then the `DROP COLUMN`. An inline UNIQUE or foreign key needs no statement, because `shiftSchemaIndicesForDrop` already removes it when the column drops.

The undo is SQL text computed at plan time, so the stored CHECK names have to be predicted. `UndoRenderer.dropAddedColumn` calls the same `extractColumnLevelCheckConstraints` the forward step (`runAddColumn`) calls, over a set of taken names kept per table for the whole plan and seeded from the pre-apply catalog by `constraintNamesHeld`.

## Going beyond the ticket's text

`extractColumnLevelCheckConstraints` changed shape, so check you agree with it:

- It now adds the column's own user-written names to the taken set itself. Both callers previously had to do that as a separate line, and leaving it in each caller was the likeliest way for them to drift.
- `takenNames` is required. It had only one caller, which always passed it.
- The return type narrows `name` to `string`, so the undo needs no assertion.

## Use cases to validate

Repro from the ticket: a table with duplicate `b`, a declaration adding `d integer null check (d > 0)` and `constraint ub unique (b)`. Expected: the apply's own `UNIQUE constraint failed` error alone, and the table back to `id, b`.

Each of these was run by script on memory, and each gave the original error alone with the columns restored:

- an unnamed CHECK
- a named CHECK
- two CHECKs
- a CHECK naming another column
- CHECK + UNIQUE + foreign key on one column
- an existing `constraint _check_d`
- an earlier added column's `constraint _check_d unique`
- `check on insert`
- a renamed table

## Tests added

All three fail with the `DROP CONSTRAINT` statements taken out of the undo, and pass with them in.

| test | verifies |
| --- | --- |
| `50.4-declare-schema-apply-restore.sqllogic` section 6 | on both backends: an added column with an unnamed CHECK, a named CHECK and an inline UNIQUE, then a failing `ADD constraint`. Asserts the error, the rows without the column, and that re-diffing reproduces the plan |
| `differ-undo-plan.spec.ts` "add column drops its inline CHECKs first…" | the name prediction: existing `_check_d`, two unnamed CHECKs, expects `_check_d_3`, `_check_d_2`, then the column |
| `differ-undo-plan.spec.ts` "an added column whose CHECK mint collides…" | a round trip through the real forward step, pinning that the taken set carries across `ADD COLUMN` steps (`_check_f_2`). The ticket asked for one spec case. This second one covers a branch the first cannot reach, so cut it if you disagree |

## Validation

Run in `packages/quereus`:

- `yarn test`: 10872 passing, 25 pending
- `yarn test:store`: 10864 passing, 33 pending
- `yarn lint`: exit 0

No failures to report.

The new `schema-differ.ts` → `constraint-builder.ts` import caused no load-order problem. `schema-differ`, `constraint-builder`, `catalog`, `table` and `index` each loaded cleanly as the first module under ts-node, so nothing had to move. I did not repeat that against `dist`.

## Known gaps

- **A unique index holding the name is still not restored.** With `create unique index _check_d` on the table, the forward step mints `_check_d_2` and the undo predicts `_check_d`. Run on memory, the apply reports `undo statement … DROP CONSTRAINT _check_d failed (… it is backed by index '_check_d' …)` and the column stays. That is honest, and no worse than before this fix. It is parked as a `NOTE:` at `constraintNamesHeld`, as the ticket directed.
- **The ticket's rename case could not be tested through a plan.** The ticket measured that after `rename column x to y`, a re-added `x` with a CHECK mints `_check_x_2`, using statements run by hand. The planner cannot produce that sequence today, because of the separate defect filed as `bug-rename-source-name-redeclared-as-new-object`. The seed handles it, but no test covers it.
- **Store coverage is section 6 only.** The script of cases above ran on memory. Store ran one combined section, which has no foreign key or CHECK-naming-another-column case. The ticket's table already showed an inline foreign key restoring on store before this fix.
- **The logic test's `-- error: ub` cannot distinguish restored from not restored**, because the wrapped "could not be restored" message also contains the original text. The row check and the re-diff are what prove the restore.

## Doc and comment corrections

- `docs/schema-undo-plan.md`: `ADD COLUMN` and `ADD constraint` are now separate rows.
- `alter-table.ts`: the install-loop comment and `revertAddColumn`'s doc comment no longer say modules leave a foreign key over a dropped column. The comment ahead of the loop only describes which names are tracked, and still reads correctly. `revertAddColumn` still drops a foreign key by name, which is now documented as redundant and harmless.
