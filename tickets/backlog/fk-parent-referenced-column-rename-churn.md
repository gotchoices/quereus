description: An FK whose *referenced column on the parent table* is renamed still churns a redundant DROP+ADD on the child constraint. The sibling ticket `constraint-body-change-rename-churn` suppressed this churn for CHECK/UNIQUE columns and FK local columns + FK parent *table* renames, but a renamed *parent referenced column* is not reconcilable in the current single-pass differ — the parent's column renames are computed in the parent's own per-table diff and aren't visible cross-table when the child's `computeTableAlterDiff` runs.
files:
  - packages/quereus/src/schema/schema-differ.ts            # reconciledDeclaredBody (FK case) + computeSchemaDiff single-pass loop
  - packages/quereus/test/declarative-equivalence.spec.ts   # describe('rename without constraint churn') — add a parent-referenced-column case
----

## Problem

`reconciledDeclaredBody` (in `schema-differ.ts`) reconciles a declared constraint
body back to its pre-rename form so a pure rename does not emit a spurious
`DROP CONSTRAINT` + `ADD CONSTRAINT` on top of the rename already in the diff.

It handles:
- CHECK over a renamed column
- UNIQUE over a renamed column
- FK over a renamed **local (child)** column
- FK whose **parent table** is renamed

It does **not** handle: an FK whose **referenced column on the parent table** is
renamed. Example — rename `parent.pid → parent.key` while a child FK references it:

```
foreign key (pa) references parent(pid)   -- before
foreign key (pa) references parent(key)   -- after (parent col renamed)
```

The child's `computeTableAlterDiff` sees the declared FK referencing `key` and the
actual catalog FK referencing `pid`, registers a body change, and churns a
drop+recreate of the child FK — re-validating every child row on what is really a
metadata-only parent-column rename.

## Why it's deferred (architecture)

The differ is **single-pass**: each table's alter diff is computed independently
in `computeSchemaDiff`'s table loop. The parent's column renames (its
`columnsToRename`) are resolved inside the parent's own `computeTableAlterDiff`
call and are not threaded to the child's call. `reconciledDeclaredBody` only
receives the **table** renames (`tableRenames`) and the **current table's** column
renames (`diff.columnsToRename`) — it has no visibility into another table's
column renames.

## Severity

Low. Not a regression — this narrow case churned a drop+recreate before the
`constraint-body-change-rename-churn` fix too; that fix simply did not extend to
it. It converges correctly (RENAME runs before DROP/ADD), it just wastes an FK
re-validation scan and incurs the non-atomic drop+recreate window on the memory
backend, the same cost the sibling ticket removed for the other rename shapes.

## Sketch of a fix (two-pass)

Resolve **all** per-table column renames first (a pre-pass over the table loop
that fills a `Map<tableNameLower, ColumnRenameOp[]>`), then run the body
comparison with cross-table column-rename visibility so an FK's referenced parent
column can be inverse-rewritten the same way the local column already is. The FK
branch of `reconciledDeclaredBody` would inverse-rename `foreignKey.columns`
against the *parent's* column renames (looked up by the reconciled parent table
name).

## Acceptance

- A declared FK whose only change is a renamed parent referenced column (with the
  parent column rename hinted in the same diff) emits ONLY the parent's
  `RENAME COLUMN` — no `DROP CONSTRAINT` / `ADD CONSTRAINT` on the child.
- The FK still enforces against the renamed parent column after apply.
- Idempotent re-apply (no further alter).
- Precedence preserved: a genuine FK body edit layered on a parent-column rename
  still drops+recreates.
- Remove the "KNOWN LIMITATION" notes in `reconciledDeclaredBody`'s JSDoc and in
  `docs/schema.md` once landed.
