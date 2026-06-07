description: The canonical-body renderers used for schema-diff drift detection (named constraints, primary key, and now indexes) preserve column-identifier *case* via `quoteIdentifier(col.name)`, while the differ treats column names case-insensitively everywhere else (`.toLowerCase()` in PK comparison and column lookups). A declared index/constraint whose column reference differs in case from the column *definition* (e.g. column declared `Email`, index/constraint written over `email`) therefore renders byte-unequal against the actual catalog and churns a spurious drop+recreate on every diff/apply, even though nothing changed.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # canonicalIndexedColumnsToString, tableConstraintsToString (unique/fk/pk column lists), foreignKeyClauseTail (referenced cols)
  - packages/quereus/src/schema/ddl-generator.ts         # indexToCanonicalDDL, constraintToCanonicalDDL — actual-side lift (renders stored canonical-case column names)
  - packages/quereus/src/schema/schema-differ.ts         # pkSequencesEqual / column lookups already lowercase — the inconsistency reference point
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # declarative differ stability describe — add a mixed-case no-churn case
----

# Canonical-body column-name case normalization (constraint / PK / index drift)

## Problem

The declarative schema differ detects "name-matched object whose body changed"
by rendering a **canonical body string** on both sides and comparing byte-equal:

- declared side: rendered from the parsed AST (`ast-stringify`),
- actual side: lifted from the stored schema and rendered through the *same*
  function (`ddl-generator`'s `indexToCanonicalDDL` / `constraintToCanonicalDDL`).

Every bare column-name identifier in those bodies flows through
`quoteIdentifier(name)`, which **preserves case**. On the actual side `name` is
the stored column's *definition* case (`tableSchema.columns[i].name`); on the
declared side it is whatever case the user typed in the index/constraint column
list. When those two cases differ, the bodies compare unequal and the differ
schedules a needless **drop + recreate** (index) or **drop + add** (constraint) —
on *every* diff, never converging.

This contradicts the rest of the differ, which is deliberately case-insensitive
about column names: `pkSequencesEqual` compares `declared[i].name.toLowerCase()`
against `actual[i].columnName.toLowerCase()`, and column-index lookups key off
`.toLowerCase()`. SQL unquoted identifiers are case-insensitive, and Quereus
resolves columns case-insensitively, so the canonical renderers should agree.

This is **pre-existing** — it already affects the named-constraint UNIQUE / FK /
referenced-column lists and the PK path — and was inherited by the index
body-drift path added in `schema-differ-index-body-drift`. Severity is low: the
recreate produces a *correct* object, it is just unnecessary work (and churn in
migration output / require-hint accounting). It only triggers when a column
reference's case diverges from the column definition's case within the same
declared schema, which is unusual but legal.

## Desired behavior

A canonical body must be invariant to the *case* of a bare column-name
identifier (matching the engine's case-insensitive column resolution), while
**preserving** the case of genuinely case-sensitive material (quoted identifiers
that the engine treats as case-sensitive, string literals in CHECK/WHERE
expressions, collation names already lowercased, etc.).

## Considerations / scope

- The fix belongs in the **shared canonical renderers**, applied uniformly to:
  index column lists (`canonicalIndexedColumnsToString`), constraint UNIQUE / FK
  local column lists and FK *referenced* column lists, and the PK column list —
  so constraint, PK, and index drift stay consistent. An index-only fix would
  leave the constraint path inconsistent.
- Decide the rule for **quoted identifiers**: does Quereus treat a double-quoted
  column name as case-sensitive (SQL-standard) or fold it like an unquoted one?
  The normalization must match column *resolution* semantics — confirm how
  `tableSchema.columns[].name` is stored vs. how a quoted index/constraint
  column reference resolves before blanket-lowercasing.
- This is **canonical-comparison only** — the user-facing DDL renderers
  (`createIndexToString`, `generateIndexDDL`, `tableConstraintsToString` as used
  for actual DDL) must keep emitting the original case. Only the body-comparison
  path should normalize.
- Related but distinct from `schema-differ-index-collation-and-rename-reconciliation`
  (that one defers collation comparison and concurrent-rename reconciliation for
  indexes); this ticket is purely about identifier-case normalization across the
  canonical body family.

## Acceptance

- A declared index/constraint whose column reference differs only in case from
  the column definition produces an **empty** diff (no drop+recreate / drop+add).
- The fix is applied across index + constraint + PK canonical bodies (one shared
  normalization), not index-only.
- Genuine column-set / order / direction / body changes still recreate.
- Quoted/case-sensitive identifiers behave per the engine's actual column
  resolution semantics (no incorrect collapse).
