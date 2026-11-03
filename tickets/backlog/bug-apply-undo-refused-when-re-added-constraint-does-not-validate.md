description: When "apply schema" removes a constraint and then fails, the rollback puts the constraint back by adding it as if it were new, so it is refused if the existing rows or tables would not pass a fresh check, and the database is left half-migrated.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts   # rejectCheckViolatedByExistingRows and the FK / UNIQUE pre-dispatch guards
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # runJournalInReverse holds Database._setSchemaUnwinding
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer: DROP CONSTRAINT undo renders ADD constraint
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The failure is reported honestly and needs both a constraint the rows no longer satisfy and an unrelated later failure in the same apply; skipping validation on re-add also has to be squared with a module's own scan and with enforcement structures it must still rebuild.

# A rollback's re-added constraint is validated as if it were new

The undo of `DROP CONSTRAINT c` is `ADD constraint c …`, and that statement validates the constraint against the current catalog and rows. Those checks protect a user adding a new rule. In an unwind the constraint is one the table already had, so a state it passed through before the apply can fail them, and the unwind stops with "partially migrated".

## Reproduction

All on memory, from `t (id, b)` with rows `(1, 1), (2, 1)`. Each declaration removes constraint `c` from `e`, declared ahead of `t` so that step runs first, and then adds `constraint ub unique (b)` to `t`, which fails forward. Each ended in "could not be restored":

| starting state of `e` | refusal from the undo |
|---|---|
| `c check (x > (select max(id) from o))`, with a row that passed when written and no longer does because `o` grew | `CHECK constraint failed: c — existing rows in 'e' violate the constraint` |
| `c check (x > (select max(id) from zz))`, where `zz` does not exist | `Table 'zz' not found in schema path: main` |
| `c foreign key (x) references p(id)`, with a row inserted under `pragma foreign_keys = off` that has no parent | `FOREIGN KEY constraint failed: e (x) has rows referencing a missing 'p'` |

The first shape needs no unusual setup beyond a CHECK that reads another table, which can stop holding for old rows without any write to `e`.

## Expected behavior

An unwind that re-adds a constraint returns the table to what it was, including rows that would not pass a fresh check, and the apply reports the step's own error. The enforcement structures a re-added constraint needs, such as a UNIQUE's covering index, must still be built. `Database._setSchemaUnwinding` already marks these statements. A backend's own row scan is part of what has to stand down.
