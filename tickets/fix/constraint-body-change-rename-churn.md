description: A column/table rename referenced by a NAMED constraint triggers a redundant constraint DROP+ADD (drop+recreate) in addition to the rename — the declarative differ sees the constraint body as "changed" because the actual `definition` carries the old name while the declared one carries the new name. For UNIQUE/FK this wastes a full re-validation scan and (given the non-atomic drop+recreate) opens a new failure window on a previously-safe rename.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts            # computeTableAlterDiff: body-change detection vs the column/constraint rename passes
  - packages/quereus/src/schema/catalog.ts                  # CatalogTable.namedConstraints[].definition (rendered with CURRENT col/table names)
  - packages/quereus/src/schema/ddl-generator.ts            # constraintToCanonicalDDL / schemaConstraintToTableConstraint (actual-side render)
  - packages/quereus/src/emit/ast-stringify.ts              # constraintBodyToCanonicalString (declared-side render)
  - packages/quereus/src/runtime/emit/alter-table.ts        # propagateColumnRename / rewriteTableForColumnRename already rewrite the constraint on rename
  - packages/quereus/test/declarative-equivalence.spec.ts   # add coverage for rename-without-constraint-churn
----

# Column/table rename referenced by a named constraint churns a redundant constraint drop+recreate

## Symptom

With the body-change detection added in `10.3-alter-constraint-body-change-drop-add`, renaming a
column (or the parent table under an FK) that is referenced by a **named** constraint now emits a
spurious `DROP CONSTRAINT` + `ADD CONSTRAINT` **on top of** the rename.

Reproduction (verified during 10.3 review):

```sql
declare schema main { table t { id integer primary key, qty integer, constraint chk check (qty > 0) } }
apply schema main;
-- rename qty -> quantity via a previous_name hint (constraint body semantically unchanged):
declare schema main {
  table t { id integer primary key,
            quantity integer with tags ("quereus.previous_name" = 'qty'),
            constraint chk check (quantity > 0) }
}
diff schema main;
--   ALTER TABLE t RENAME COLUMN qty TO quantity
--   ALTER TABLE t DROP CONSTRAINT chk          <-- spurious
--   ALTER TABLE t ADD constraint chk check (quantity > 0)   <-- spurious
```

The same shape reproduces for a named UNIQUE over the renamed column, and (by inspection) for an FK
whose parent table is renamed (the FK `references <table>` text changes).

## Root cause

`computeTableAlterDiff` compares each named constraint's canonical body `definition`:
- the **actual** side (`catalog.ts` → `constraintToCanonicalDDL`) renders the stored constraint with
  the table's **current** column / referenced-table names (`qty`);
- the **declared** side (`constraintBodyToCanonicalString`) renders the declaration's AST with the
  **new** names (`quantity`).

These strings differ, so the body-change path fires — even though the column-rename pass that runs in
the same diff would already have rewritten the constraint (`propagateColumnRename` /
`rewriteTableForColumnRename` in `runtime/emit/alter-table.ts` rewrite CHECK exprs, FK referenced
columns, and FK referenced tables on rename). The drop+recreate is therefore pure redundancy. The
body comparison does not account for column/table renames detected earlier in the same `TableAlterDiff`.

## Why it matters

- It converges and `apply` currently succeeds (emission orders RENAME COLUMN before DROP/ADD within
  the table block), so this is **not** an immediate correctness failure — it is wasteful churn.
- For **UNIQUE / FOREIGN KEY** the redundant re-add re-validates **every existing row** (a full scan)
  on what should be a metadata-only rename — a performance regression that scales with table size.
- The drop+recreate is **not atomic** across its two statements on the memory backend (see 10.3 gap
  #2): a failure in the redundant re-add would leave the constraint dropped. So a previously-safe
  column rename now carries a (small but real) new failure surface.
- For **CHECK** the re-add is forward-only (no scan), so the cost is just the redundant DDL, but the
  emitted diff is still misleading.

## Expected behavior

Renaming a column or table that a named constraint references should emit **only** the rename
operation(s). A named constraint whose body is otherwise unchanged must **not** be dropped and
recreated merely because one of its referenced identifiers was renamed in the same apply. A genuine
body edit (changed predicate / column set / FK action / `ON CONFLICT`) layered on top of a rename
should still drop+recreate (and, per the existing precedence rule, subsume the rename).

## Notes / direction (not a committed design)

The fix belongs in the body comparison: before comparing `definition`s, the actual-side constraint
should be evaluated as-if the already-detected column renames (`diff.columnsToRename`) and any
table rename were applied — e.g. rewrite the lifted `AST.TableConstraint` through the same rename
rewriters used at runtime, then render. String-level rewriting of the stored `definition` is the
janky-parser anti-pattern and should be avoided; reuse the AST rename rewriters. Watch the
interaction with the rename-suppression precedence already in `computeTableAlterDiff`, and ensure
idempotence (a second apply is a no-op) and the UNIQUE/FK no-scan property are covered by tests
(extend `declarative-equivalence.spec.ts` and/or a sqllogic case).
