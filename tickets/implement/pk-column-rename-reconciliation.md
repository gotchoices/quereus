description: Reconcile a table's PK sequence against in-diff column renames in the declarative differ, so a pure PK-column rename emits ONLY the RENAME COLUMN and no spurious `primaryKeyChange` / ALTER PRIMARY KEY. Mirrors the existing constraint-body rename reconciliation.
files:
  - packages/quereus/src/schema/schema-differ.ts          # computeTableAlterDiff PK block (~1136-1145); pkSequencesEqual (~1323); extractDeclaredPK (~1290); inverseRenameConstraintColumns (~800) is the helper to reuse
  - packages/quereus/test/declarative-equivalence.spec.ts # 'rename without constraint churn' describe (from line 1894); the parent-column-rename test (~2111) carries a now-stale comment to update
----

## Problem

The declarative differ reconciles named CHECK / UNIQUE / FOREIGN KEY constraint bodies
against in-diff column renames (`reconciledDeclaredBody`), so a pure rename emits only
`RENAME COLUMN`. The **PRIMARY KEY** sequence is NOT reconciled: `pkSequencesEqual` compares
PK column membership by name, so renaming a PK column makes the declared PK (new name)
differ from the actual PK (old name), and `computeTableAlterDiff` emits a spurious
`primaryKeyChange` → `ALTER PRIMARY KEY` on top of the `RENAME COLUMN`.

This extra `ALTER PRIMARY KEY` is benign for ordinary tables (applies cleanly, idempotent)
but is unnecessary churn, and on a self-referential-FK table it trips a deferred-enforcement
engine bug at the next commit (tracked separately by `self-fk-alter-primary-key-deferred-connection`).
Reconciling the PK sequence eliminates the churn.

Note the default-PK case is also affected: a table with no explicit PRIMARY KEY defaults to
all columns being the PK (key-based addressing, no rowids), so renaming *any* column in such
a table currently emits a spurious `primaryKeyChange` too. The reconciliation fixes that case
as well, for free.

## Expected behavior

A declarative apply whose ONLY change to a table is renaming a PK column (rename hinted via
`quereus.previous_name` / `quereus.id`) must emit a single `RENAME COLUMN` and **no**
`primaryKeyChange`. A genuine PK membership/order change (different columns, added/removed PK
column, direction change) must still emit the `primaryKeyChange`. Idempotent on re-apply.

## Approach

In `computeTableAlterDiff`, `diff.columnsToRename` is already populated (column-rename
detection runs before the PK block). At the PK detection site (~line 1140):

```ts
const declaredPk = extractDeclaredPK(declaredTable);
const actualPk = actualTable.primaryKey;

// Inverse-rename declared PK column names (new → old) so a pure PK-column rename
// — already emitted as RENAME COLUMN — does not also churn an ALTER PRIMARY KEY.
// Mirrors the constraint-body reconciliation (reconciledDeclaredBody). Clone first:
// inverseRenameConstraintColumns mutates in place, and declaredPk backs newPkColumns.
const reconciledDeclaredPk = declaredPk.map(c => ({ ...c }));
inverseRenameConstraintColumns(reconciledDeclaredPk, diff.columnsToRename);

if (!pkSequencesEqual(reconciledDeclaredPk, actualPk)) {
	diff.primaryKeyChange = {
		oldPkColumns: actualPk.map(pk => pk.columnName),
		newPkColumns: declaredPk, // keep NEW (declared) names for the genuine-change DDL
	};
}
```

Key points:
  - Reuse `inverseRenameConstraintColumns` — `extractDeclaredPK` returns exactly its
    `Array<{ name; direction? }>` shape. No new helper.
  - Reconcile only for the *comparison*; `newPkColumns` keeps the new declared names so a
    genuine PK change still ALTERs to the correct (new) column names.
  - PK reconciliation is **local-column-only**: a PK references this table's own columns, so
    only `diff.columnsToRename` is needed — no cross-table `columnRenamesByTable` / table
    renames (unlike the FK body case). Do not thread those in.
  - Direction is untouched by reconciliation; `pkSequencesEqual` still compares direction, so
    a genuine direction change (`asc` → `desc`) on an otherwise-renamed PK column still churns.

## Edge cases & interactions

  - **Pure single-column PK rename** → `primaryKeyChange` undefined; only `columnsToRename`.
  - **Composite PK, one member renamed** → reconciled list matches actual → no PK change.
  - **Genuine membership change** (PK column added/removed, or swapped for a different column)
    → still emits `primaryKeyChange` (regression guard).
  - **Rename + genuine membership change in the same diff** (e.g. PK `(a,b)` → declared
    `(a_renamed, c)` with `a→a_renamed` hinted): reconcile to `(a, c)` vs actual `(a, b)` →
    differs → `primaryKeyChange` emitted with `newPkColumns = (a_renamed, c)`. Verify the new
    names (not old) land in the change.
  - **Direction change layered on a PK-column rename** → still emits `primaryKeyChange`
    (reconciliation rewrites names only).
  - **Default-PK table (no explicit PRIMARY KEY = all columns)** with a column renamed →
    no spurious `primaryKeyChange`.
  - **Idempotent re-apply**: once the rename lands, the actual catalog carries the new name,
    `diff.columnsToRename` is empty, reconciliation is a no-op, and `pkSequencesEqual` matches
    directly → no alter.
  - **Stale comment**: the existing test "an FK whose referenced PARENT column is renamed…"
    (~line 2111) documents the parent's spurious `primaryKeyChange` as a "benign, pre-existing
    PK-column-rename limitation" it deliberately doesn't assert away. That limitation is now
    fixed — update the comment (lines ~2114-2117) so it no longer claims the churn occurs. The
    test itself still passes (it never asserted the `primaryKeyChange` was present), but the
    prose is now wrong.

## Tests

Add to `declarative-equivalence.spec.ts` `describe('declarative-equivalence: rename without constraint churn')`
(follow the existing `diffOf` / `generateMigrationDDL` pattern in that block):

  - **pure PK-column rename emits ONLY RENAME COLUMN**: declare `table t { id INTEGER PRIMARY
    KEY }`, apply; redeclare `table t { pk INTEGER PRIMARY KEY with tags ("quereus.previous_name"
    = 'id') }`. Assert the alter's `columnsToRename` = `[{ oldName: 'id', newName: 'pk' }]`,
    `primaryKeyChange` is `undefined`, DDL has `RENAME COLUMN … id … TO … pk` and NO
    `ALTER PRIMARY KEY`. Apply, then assert `diffOf(db).tablesToAlter` is `[]` (idempotent).
  - **composite PK, one column renamed → no PK change**: e.g. `table t { a INTEGER, b INTEGER,
    constraint pk primary key (a, b) }`, apply; rename `a → a2` via hint, keeping `primary key
    (a2, b)`. Assert `primaryKeyChange` undefined, idempotent.
  - **REGRESSION: genuine PK membership change still emits `primaryKeyChange`**: change the PK
    to a different/added column (no rename hint reconciling it) and assert `primaryKeyChange`
    is present with the expected `newPkColumns`.

## TODO

- Edit `computeTableAlterDiff` PK block in `schema-differ.ts` per the Approach above.
- Add the three tests to the `rename without constraint churn` describe block.
- Update the stale comment in the parent-column-rename test (~lines 2114-2117).
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/pk-rename.log; tail -n 60 /tmp/pk-rename.log` and confirm green (declarative-equivalence + no regressions).
- Run lint on `packages/quereus` (single-quote globs on Windows).
