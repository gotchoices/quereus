description: When "apply schema" removes a view or a table's maintained definition and then fails, the rollback recreates it as if it were new, so it is refused if the object was already broken or its rows would not pass a fresh check, and the database is left half-migrated.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer: the undo of DROP VIEW and DROP MAINTAINED
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # existing-row validation of a maintained table's derivation
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # runJournalInReverse holds Database._setSchemaUnwinding
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The failure is reported honestly and needs both an object that would not pass a fresh check and an unrelated later failure in the same apply; a view that no longer compiles may have no way back without storing it unvalidated, which the view path does not do today.
----

# A rollback's recreated view or maintained definition is validated as if it were new

This is the same kind of failure as `bug-apply-undo-refused-when-re-added-constraint-does-not-validate`, at different statements. The undo journal of a failed `apply schema` is ordinary DDL, so these undo statements judge the object against the current state. An unwind should return to the pre-apply state whether or not that state would pass.

## Reproduction

Run on the memory backend through a temporary spec, from `t (id, b)` with rows `(1, 1), (2, 1)`. Each declaration removes the object below and adds `constraint ub unique (b)` to `t`, which fails forward. Both ended in "The schema is partially migrated and could not be restored":

| starting state | undo statement | refusal |
|---|---|---|
| `create table g (id integer primary key); create view v as select id from g; drop table g;`, so `v` no longer compiles, and the declaration omits `v` | `create view v as select id from g` | `Table 'g' not found in schema path: main` |
| table `m` with `constraint c foreign key (x) references p(id)`, made maintained from `src` under `pragma foreign_keys = off`, with a source row whose `x` has no parent. The declaration keeps `m` but not as maintained | `alter table m set maintained as select id, x from src` | `FOREIGN KEY constraint failed: c — row derived into maintained table 'main.m' references a missing 'main.p'` |

Two related shapes restored correctly in the same probe: a dropped unique index, and a dropped assertion that the existing rows violated.

## Expected behavior

An unwind that recreates a view or a maintained definition returns it to what it was, even if it no longer compiles or validates, and the apply reports the failing step's own error.

Only the foreign key arm of the maintained-table validation was observed. Its CHECK and UNIQUE arms are expected to behave the same way from reading the code, and were not run.
