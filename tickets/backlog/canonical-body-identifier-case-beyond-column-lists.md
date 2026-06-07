description: After `canonical-body-column-name-case-normalization` folds bare column-name *column lists* to lowercase in the schema-differ canonical bodies, two adjacent identifier-case channels still preserve case and can churn a spurious drop+recreate when a reference's case diverges: (1) column references embedded inside CHECK expressions and partial-index WHERE predicates, and (2) the FK *referenced table* name. Both are case-insensitive at resolution time but render case-preserving in the canonical body.
prereq: canonical-body-column-name-case-normalization
files:
  - packages/quereus/src/emit/ast-stringify.ts          # expressionToString (column/identifier nodes), foreignKeyClauseTail (references <table>)
  - packages/quereus/src/schema/schema-differ.ts         # canonical body comparison for CHECK / partial-index WHERE / FK
----

# Canonical-body identifier-case normalization beyond column lists

## Background

`canonical-body-column-name-case-normalization` establishes that Quereus has no
case-sensitive identifiers (the AST does not track quoting; all resolution folds
with `.toLowerCase()`), and lowercases bare column-name identifiers in the
canonical **column lists** the differ compares (index columns, UNIQUE / FK local
+ referenced column lists, PK columns). That fixes the high-frequency churn where
the actual side renders the column *definition* case and the declared side renders
the *reference* case.

Two adjacent channels were left case-preserving in that pass and remain potential
churn sources:

## In scope for this ticket

1. **Column references inside CHECK expressions and partial-index WHERE
   predicates.** These render via `expressionToString` (a `column`/`identifier`
   node → `quoteIdentifier(expr.name)`), so a reference whose case differs from
   the column definition can render byte-unequal across versions and churn a
   drop+recreate (CHECK → drop+add; partial index → drop+recreate). Lower
   frequency than the column-list bug — both the actual and declared sides store
   the *as-written* reference, so a mismatch needs a case change *between schema
   versions*, not merely definition≠reference at first declaration — but still a
   spurious, never-converging migration.

   Normalization must fold only **bare column-name identifiers**, leaving
   genuinely case-sensitive material intact: string literals, blob/number
   literals, and (already-lowercased) collation names. A naive lowercase of the
   whole rendered string is wrong. Likely shape: a canonical-only expression
   renderer (or a pre-pass clone) that lowercases `column`/`identifier` node
   `name` (and qualifier) while leaving `literal` nodes untouched — reuse the
   existing AST walk machinery (`predicate-shape.ts`, `rename-rewriter.ts`) rather
   than hand-rolling a parser.

2. **FK referenced *table* name** (`fk.table` → `references <table>` in
   `foreignKeyClauseTail`). A table identifier is case-insensitive at resolution,
   but the canonical FK body renders it case-preserving, so a parent-table
   reference whose case differs from the stored table name can churn an FK
   drop+add. Fold it in the canonical FK body only (persistence keeps original
   case).

## Acceptance

- A CHECK constraint / partial index whose embedded column reference differs only
  in case from the column definition produces an empty diff.
- An FK whose referenced-table reference differs only in case from the parent
  table's stored name produces an empty diff.
- String literals, numeric/blob literals, and collation names in CHECK/WHERE
  bodies are preserved exactly (no case folding) — a literal-case change is NOT a
  body change channel here, but must not be corrupted either.
- Genuine body edits (changed predicate, changed FK target table, changed
  literal value) still recreate.
- Canonical-comparison only — user-facing / persistence DDL keeps original case.

## Notes

- Confirm whether qualified references (`alias.col`, `schema.table.col`) appear in
  CHECK / WHERE canonical bodies and, if so, fold the column part consistently
  with how the rename rewriter / coverage prover treat qualifiers.
- Keep the persistence fixed-point tests green (the canonical fold must not leak
  into `generateTableDDL` / `generateIndexDDL` / `createIndexToString`).
