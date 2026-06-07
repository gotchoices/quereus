description: Canonical-body drift renderers case-fold bare column-name identifiers (index column list; named-constraint UNIQUE / PK / FK local + referenced column lists) so a column reference whose case diverges from the column definition no longer churns a spurious drop+recreate / drop+add on every diff. Persistence renderers keep original case. Implemented, reviewed, and merged.
files:
  - packages/quereus/src/emit/ast-stringify.ts            # canonicalIndexedColumnsToString (~861 lowercase); lowercaseTableConstraintColumnNames helper (~1394) applied in constraintBodyToCanonicalString (~1435)
  - packages/quereus/src/schema/ddl-generator.ts          # actual side — unchanged (indexToCanonicalDDL / constraintToCanonicalDDL funnel through the shared renderers, lift the column DEFINITION case)
  - packages/quereus/src/schema/catalog.ts                # actual side — unchanged (CatalogIndex/namedConstraints definitions produced via the renderers)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # +2 index mixed-case no-churn + 1 reserved-word probe in "declarative differ stability"
  - packages/quereus/test/declarative-equivalence.spec.ts # +3 UNIQUE / FK-local / FK-referenced mixed-case no-churn + 1 end-to-end apply-convergence probe
  - docs/schema.md                                        # case-fold note added to the constraint (#436) and index (#440) body-change sections
  - tickets/backlog/canonical-body-identifier-case-beyond-column-lists.md  # parked: CHECK-expr refs + FK referenced TABLE name
----

# Canonical-body column-name case normalization — completed

## What shipped (one idea)

The declarative differ detects a "name-matched object whose body changed" by rendering a
**canonical body string** on both the declared-AST side and the actual-catalog side and
comparing byte-equal. Every bare column-name identifier flowed through `quoteIdentifier`,
which preserves case. The actual side renders the column *definition* case
(`tableSchema.columns[i].name`); the declared side renders the as-written index/constraint
*reference* case. When those diverged, the bodies compared unequal and the differ scheduled a
needless **drop+recreate** (index) / **drop+add** (constraint) on every diff, never
converging. Fix: lowercase bare column-name identifiers **inside the canonical-only
renderers** (`quoteIdentifier` still runs after, so a reserved-word column re-quotes
correctly), matching Quereus's uniformly case-insensitive column resolution.

Two surgical edits, both in `ast-stringify.ts`:
1. `canonicalIndexedColumnsToString` — lowercase the bare name before `quoteIdentifier`.
2. `lowercaseTableConstraintColumnNames` (new, non-mutating clone helper) applied at the top
   of `constraintBodyToCanonicalString`, before the existing FK/CHECK default normalization —
   covers UNIQUE / PRIMARY KEY column lists, FK local (child) and FK referenced (parent)
   column lists. CHECK passes through unchanged (refs live in the expression — parked).

Persistence renderers (`indexedColumnsToString`, `tableConstraintsToString`,
`generateIndexDDL`, `generateTableDDL`) are deliberately untouched, so stored CREATE TABLE /
CREATE INDEX round-trips its declared casing.

## Review findings

### Diff reviewed
Read the full implement diff (`aec9a49c`) with fresh eyes before the handoff summary:
`ast-stringify.ts` (source), `docs/schema.md`, and both test specs. Cross-checked the two
*claimed-unchanged* actual-side files (`ddl-generator.ts` `indexToCanonicalDDL` /
`constraintToCanonicalDDL` / `schemaConstraintToTableConstraint`; `catalog.ts`
`indexSchemaToCatalog` / named-constraint collection) and `constraint-builder.ts`
(`referencedColumnNames: fk.columns`, `referencedTable: fk.table` — both stored as-written).

### Correctness — verified, no findings
- **Both sides funnel through the shared renderers.** `git show` confirmed `ddl-generator.ts`
  and `schema-differ.ts` carry no edit; the actual side lifts the column *definition* case
  (`tableSchema.columns[col.index].name` for indexes, `colName(i)` for constraints) and now
  picks up the lowercase automatically. The fold makes both sides case-insensitive.
- **Mutation safety.** `lowercaseTableConstraintColumnNames` clones every column array
  (`{ ...c, name: ... }`, `map`) and never touches the input `DeclaredNamedConstraint.bodyAst`.
  `constraintBodyToCanonicalString` operates on a fresh spread copy. `direction` and all other
  constraint fields survive the clone (checked against the `TableConstraint` / `IndexedColumn`
  AST shapes in `ast.ts`).
- **Reserved-word re-quoting.** `quoteIdentifier` lowercases-then-keyword-checks, so
  `Order` → `order` → `"order"` on both sides — confirmed by a NEW probe test (added).
- **FK referenced-column / referenced-table asymmetry is sound.** Referenced columns are
  stored as-written (so the bug is a between-versions case — covered by the implementer's
  test); referenced *table* name is also as-written on both sides (no within-declaration
  churn), correctly parked for the between-versions case.
- **PK helper coverage is inert but harmless.** PRIMARY KEY drift routes through
  `pkSequencesEqual` (already case-folding, untouched), never `constraintBodyToCanonicalString`;
  the helper's `primaryKey` branch is renderer-family consistency only. Verified.

### Tests — extended beyond the implementer's floor
The 5 implementer tests genuinely pin the bug (confirmed-fail-without-fix was documented). Added:
- **index-ddl-roundtrip.spec.ts**: a reserved-word (`"Order"`) index column in mixed case
  re-quotes to `"order"` identically on both sides with no churn.
- **declarative-equivalence.spec.ts**: an **end-to-end apply-convergence** probe for a
  mixed-case UNIQUE — first apply realizes & enforces the constraint, re-diff yields neither a
  diff nor any `generateMigrationDDL` output (proves the no-churn *decision* also means no
  migration DDL *executes*).
- Full package suite: **5197 passing, 9 pending, 0 failing**. `tsc --noEmit` clean; `eslint`
  clean on all changed files.

### Notable discovery (out of scope — no action)
A probe for a **collation-folded index column** (`email COLLATE NOCASE DESC`) could not be
written through the apply path: the engine rejects ALL expression-form index columns —
including the parser's `col COLLATE x` fold — with *"Indices on expressions are not supported
yet"* (`manager.ts buildIndexSchema`). So the collate-branch of `indexedColumnBareName`
(`col.expr.expr.name`) is effectively **unreachable** via real apply, and the lowercase added
there is harmless dead-path consistency. This is a **pre-existing** engine limitation (the
collate-bare-name handling predates this ticket) and orthogonal to case normalization — left
untouched; the invalid probe was removed.

### Docs — verified current
`docs/schema.md` constraint (#436) and index (#440) body-change sections both carry an accurate
case-fold note. No other doc references the canonical renderers' casing behavior.

### Disposition
- **Minor findings:** none requiring inline fixes — implementation is correct and surgical.
- **Major findings:** none. No new tickets filed. The two pre-existing parks
  (CHECK-expr refs + FK referenced TABLE name in
  `backlog/canonical-body-identifier-case-beyond-column-lists`; collate/rename index work in
  `schema-differ-index-collation-and-rename-reconciliation`) remain appropriately scoped.

### Not run (low risk, flagged in handoff)
`yarn test:store` (LevelDB path) was not run — the change touches only the in-memory canonical
comparison renderers, not the persistence DDL path (store rehydration uses the untouched
`tableConstraintsToString` / `generateIndexDDL`). Persistence round-trip is guarded by the
emit-roundtrip specs (green). A store-path spot check would be belt-and-suspenders only.
