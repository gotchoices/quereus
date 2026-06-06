description: Renaming a table's PRIMARY KEY column via the declarative differ emits a redundant `primaryKeyChange` (ALTER PRIMARY KEY) on top of the RENAME COLUMN, because `pkSequencesEqual` compares PK columns by name with no rename reconciliation. Mirror the constraint-body rename reconciliation (`reconciledDeclaredBody`) for the PK sequence so a pure PK-column rename emits ONLY the RENAME COLUMN.
files:
  - packages/quereus/src/schema/schema-differ.ts          # pkSequencesEqual + primaryKeyChange detection; reconciledDeclaredBody / inverseRename* helpers + columnRenamesByTable as the model to follow
  - packages/quereus/test/declarative-equivalence.spec.ts # 'rename without constraint churn' describe — add a PK-column-rename-only no-churn case
----

## Problem

The declarative differ already reconciles **named CHECK / UNIQUE / FOREIGN KEY** constraint
bodies against in-diff column renames (so a pure rename emits only `RENAME COLUMN`, no
constraint drop+recreate — see `reconciledDeclaredBody`). The **PRIMARY KEY** sequence is
NOT reconciled: `pkSequencesEqual` compares PK column membership by name, so renaming a PK
column makes the declared PK (new name) differ from the actual PK (old name) and the differ
emits a spurious `primaryKeyChange` → `ALTER PRIMARY KEY` in addition to the `RENAME COLUMN`.

For ordinary tables this extra `ALTER PRIMARY KEY` is **benign** — the apply succeeds and is
idempotent (verified by the FK-parent-referenced-column-rename tests, which apply cleanly
with it present). But it is unnecessary churn, and on a **self-referential-FK** table the
`ALTER PRIMARY KEY` trips a deferred-enforcement engine bug at the next commit (see fix
ticket `self-fk-alter-primary-key-deferred-connection`). Reconciling the PK sequence would
eliminate the churn and, as a side effect, sidestep that trigger for the pure-PK-rename case
(though the engine bug should still be fixed independently for any `ALTER PRIMARY KEY`).

## Expected behavior

A declarative apply whose ONLY change to a table is renaming a PK column (with the rename
hinted) must emit a single `RENAME COLUMN` and **no** `primaryKeyChange` / `ALTER PRIMARY
KEY`. A genuine PK membership/order change (different columns, added/removed PK column)
must still emit the `primaryKeyChange`. Idempotent on re-apply.

## Approach sketch

Thread the table's own `columnsToRename` (already computed in `computeTableAlterDiff`) into
the PK comparison and inverse-rename the declared PK column names (new → old) before
`pkSequencesEqual`, exactly as `inverseRenameConstraintColumns` does for UNIQUE/FK column
lists. The `columnRenamesByTable` map and the inverse-rename helpers added by
`fk-parent-referenced-column-rename-churn` are the template.

## Tests

Add to `declarative-equivalence.spec.ts` `describe('rename without constraint churn')`:
  - pure PK-column rename emits ONLY `RENAME COLUMN`, `primaryKeyChange` undefined, idempotent;
  - composite PK with one column renamed → still no PK change;
  - genuine PK membership change → `primaryKeyChange` still emitted (regression guard).
