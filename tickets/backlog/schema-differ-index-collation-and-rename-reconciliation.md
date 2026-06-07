description: Follow-on to schema-differ-index-body-drift. Extend index body-drift detection to (a) include per-column collation in the canonical body comparison without false churn, and (b) reconcile a declared index body against concurrent column/table renames in the same diff (mirroring reconciledDeclaredBody for constraints).
files:
  - packages/quereus/src/emit/ast-stringify.ts        # createIndexBodyToCanonicalString (added by the drift ticket)
  - packages/quereus/src/schema/ddl-generator.ts      # indexToCanonicalDDL
  - packages/quereus/src/schema/schema-differ.ts      # index loop; reconciledDeclaredBody / column-rename infrastructure model
  - packages/quereus/src/schema/catalog.ts            # CatalogIndex.definition
----

# Index body drift: collation + concurrent-rename reconciliation

`schema-differ-index-body-drift` deliberately scoped out two refinements to keep
the core fix to one coherent change. This ticket captures them.

## Collation in the canonical index body

The drift detector excludes per-column collation from the canonical body so an
inherited / default-`BINARY` collation on the declared side does not churn against
the resolved, always-explicit collation the actual `IndexSchema` stores. Including
collation correctly requires resolving the declared index's effective collation
the same way `buildIndexSchema` / `importIndex` does — per-column `COLLATE` →
declared table column collation → `BINARY`, then normalized — and rendering both
sides identically (BINARY elided, or both explicit). The table-column collation
must be read from the declared `ColumnDef` (a `collate` column constraint), and
the case where the *table column's* collation changes in the same diff has to be
considered (does the index follow, or recreate?).

Expected behavior: a same-named index whose only change is a column's collation
(e.g. `text` → `text collate nocase` reflected in the index, or an explicit index
`COLLATE`) drops+recreates; an inherited collation that is unchanged never churns.

## Concurrent column / table rename reconciliation

The drift detector does not reconcile an index body against a column or table
rename happening in the same diff. A same-named index over a column renamed in the
same apply renders the new name (declared) vs the old name (actual `definition`)
and produces an unnecessary drop+recreate — churn, not corruption. Constraints
already solve this via `reconciledDeclaredBody` (schema-differ.ts): inverse-apply
the in-diff column renames (and parent-table renames for FK) to the declared body
before comparing. Indexes need the analogous reconcile: inverse-apply the matched
table's `columnsToRename` to the declared index's column list (and unwrap the
collate-folded column form) before the canonical compare, so a pure column rename
under a stable-named index does not churn while a genuine body edit still does.

Expected behavior: renaming a column that a same-named index references (via
`quereus.previous_name` / `quereus.id` hint) produces only the column rename, not
an index drop+recreate; a body edit layered on the rename still recreates.

## Notes

- Both refinements build directly on the canonical renderer + `CatalogIndex.
  definition` introduced by the drift ticket.
- Add regression cases under the "declarative differ stability" describe in
  `index-ddl-roundtrip.spec.ts`.
