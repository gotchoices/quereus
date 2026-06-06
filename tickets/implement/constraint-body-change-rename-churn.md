description: Suppress the spurious named-constraint DROP+ADD that a column/parent-table rename triggers in the declarative differ. A named CHECK/UNIQUE/FK whose body is unchanged except for a renamed identifier (handled by the rename pass in the same diff) must emit ONLY the rename, not a redundant drop+recreate. Fix lives in `computeTableAlterDiff`'s body comparison: reconcile the declared constraint body against the already-detected column renames (and threaded-in table renames) before comparing to the actual canonical body.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts            # computeTableAlterDiff body-change loop (line ~873-886); collectDeclaredNamedConstraints; DeclaredNamedConstraint
  - packages/quereus/src/schema/rename-rewriter.ts          # renameColumnInCheckExpression (reuse for CHECK expr inverse-rewrite)
  - packages/quereus/src/planner/mutation/scope-transform.ts # cloneExpr — deep structural clone of an AST.Expression (idiomatic, reuse it)
  - packages/quereus/src/emit/ast-stringify.ts              # constraintBodyToCanonicalString (canonical render of the reconciled AST.TableConstraint)
  - packages/quereus/src/schema/catalog.ts                  # CatalogTable.namedConstraints[].definition (actual-side canonical body string)
  - packages/quereus/test/declarative-equivalence.spec.ts   # add the no-churn coverage (mirror the "body change (drop+recreate)" describe block)
----

# Suppress redundant constraint drop+recreate on a rename-only identifier change

## Problem (confirmed reproduction)

In `computeTableAlterDiff` (`schema-differ.ts`), the named-constraint body-change detection compares
two canonical body strings:

- **declared** side — `DeclaredNamedConstraint.definition`, rendered from the declaration's AST with
  the **new** identifier names;
- **actual** side — `CatalogTable.namedConstraints[].definition`, rendered from the live catalog with
  the **current/old** identifier names (the rename has not been applied yet at diff time).

When a column (or an FK's parent table) is renamed in the same apply, these strings differ purely
because of the renamed identifier, so the body-change path (line ~880) fires a `DROP CONSTRAINT` +
`ADD CONSTRAINT` **on top of** the rename that the diff already emits.

Verified during this fix (memory backend, `computeSchemaDiff` + `generateMigrationDDL`):

```
-- column rename qty -> quantity, CHECK body semantically unchanged
columnsToRename:   [{"oldName":"qty","newName":"quantity"}]
constraintsToDrop: ["chk"]                                   <-- spurious
constraintsToAdd:  ["constraint chk check (quantity > 0)"]   <-- spurious
DDL: [ "ALTER TABLE t RENAME COLUMN qty TO quantity",
       "ALTER TABLE t DROP CONSTRAINT chk",                  <-- spurious
       "ALTER TABLE t ADD constraint chk check (quantity > 0)" ]  <-- spurious

-- same shape for a named UNIQUE over the renamed column:
[UNIQUE] constraintsToDrop: ["uq"]  constraintsToAdd: ["constraint uq unique (quantity)"]

-- FK whose PARENT TABLE is renamed (parent -> p2):
[FK] renames: [{"kind":"table","oldName":"parent","newName":"p2"}]    <-- top-level diff.renames
[FK] child constraintsToDrop: ["fk"]
[FK] child constraintsToAdd:  ["constraint fk foreign key (pa) references p2(pid)"]  <-- spurious
```

### Why it matters
- Converges today (RENAME COLUMN is emitted before DROP/ADD within the table block), so this is
  **churn, not a correctness break** — but:
- For **UNIQUE / FK** the redundant re-add re-validates **every existing row** (full scan) on a
  metadata-only rename — a perf regression scaling with table size.
- The drop+recreate is **not atomic** across its two statements on the memory backend (10.3 gap #2):
  a failure in the redundant re-add would leave the constraint dropped — a new failure surface on a
  previously-safe rename.
- For **CHECK** the re-add is forward-only (no scan), so cost is just misleading DDL.

## Root cause

`computeTableAlterDiff` body comparison does not account for the column/table renames detected in the
**same** diff. The column renames are already in scope (`colRenames` / `diff.columnsToRename`); the
table renames are computed at the top level (`tableRenames.renames`, pushed into `diff.renames`) but
are **not** passed into `computeTableAlterDiff` (it currently receives only `declaredTable`,
`actualTable`, `policy`). The FK-parent-table case (verified above) therefore needs the table renames
threaded in.

## Fix direction (committed design)

Reconcile the **declared** constraint body back to the **actual** (pre-rename) identifier names
before comparing — i.e. apply the *inverse* of the already-detected renames to a clone of the
declared constraint AST, render it canonically, and compare to the actual `definition` string. Chosen
over the ticket's "rewrite the actual side forward" sketch because the actual side is only a string in
the catalog (rewriting it forward would require enriching `CatalogTable.namedConstraints` with a
lifted `AST.TableConstraint` on every entry — catalog bloat + serialization). Inverse-on-declared
keeps the whole change inside `schema-differ.ts` (plus a small thread-through), reuses the same
canonical renderer on both sides (byte-comparable), and reuses the runtime CHECK rewriter.

Both directions are detection-equivalent: a genuine body edit layered on a rename still differs after
reconciliation, so the existing rename-vs-body precedence (drop+recreate subsumes the rename) is
preserved.

### Mechanics

1. **Thread table renames into `computeTableAlterDiff`.** Add a parameter (e.g.
   `tableRenames: ReadonlyArray<RenameOp>` or a prebuilt `Map<oldLower,newName>`) and a
   `schemaName: string` (use `actualCatalog.schemaName` — needed as the `defaultSchemaName` for the
   CHECK rewriter). Pass `tableRenames.renames` (filtered to `kind === 'table'`) and
   `actualCatalog.schemaName` from the call site at `schema-differ.ts:310`.

2. **Keep the lifted body AST on the declared constraint.** In `DeclaredNamedConstraint` add
   `bodyAst: AST.TableConstraint`; populate it in `collectDeclaredNamedConstraints` with the same `tc`
   already passed to `constraintBodyToCanonicalString` (table-level `c` or the lifted column-level
   `tc`). Do **not** mutate this AST later (it backs `ddl`/`definition`) — clone before rewriting.

3. **New helper** `reconciledDeclaredBody(d, colRenames, tableRenames, tableName, schemaName): string`:
   - Build a surgical clone of `d.bodyAst` mutating only what each kind needs (no whole-tree clone
     required):
     - **CHECK**: `{ ...tc, expr: cloneExpr(tc.expr) }`, then for each column rename `{oldName,newName}`
       call `renameColumnInCheckExpression(clone.expr, tableName, /*old*/ newName, /*new*/ oldName, schemaName)`
       — i.e. swap the args so it rewrites `newName → oldName` (the inverse). (`cloneExpr` from
       `planner/mutation/scope-transform.ts`; the rewriter mutates in place, hence the clone.)
     - **UNIQUE**: `{ ...tc, columns: tc.columns.map(c => ({ ...c })) }`, then for each column rename
       map `col.name` from `newName → oldName` (case-insensitive). UNIQUE stores indices at runtime
       (rename is index-stable), so a direct name map is the correct analog — no expr walk.
     - **FK**: clone `columns` (as UNIQUE) AND `foreignKey` (`{ ...tc.foreignKey, columns: tc.foreignKey.columns ? [...] : undefined }`).
       Apply column renames to the local `columns` (the child columns on THIS table). Apply table
       renames to `foreignKey.table` (`newTable → oldTable`, case-insensitive).
   - Render with `constraintBodyToCanonicalString(clone)` and return the string.

4. **Use it at the comparison** (currently `if (d.definition !== matchedActual.definition)`):
   compare `reconciledDeclaredBody(...) !== matchedActual.definition` instead. When equal, the only
   difference was a rename → **skip** the drop+recreate (fall through to the existing rename/tag
   handling). When different → genuine body change → drop+recreate exactly as today.
   - Micro-opt: if `d.definition === matchedActual.definition` already (the common no-rename case),
     short-circuit to "unchanged" without building the reconciliation.

### Precedence / interaction to preserve
- `renamesSuppressedByBodyChange` / `bodyChangedNames` must only be populated for a **genuine** body
  change. Once the spurious diff is suppressed, a name-matched constraint over a renamed column flows
  to the existing tag-drift path (a real tag change still emits `ALTER CONSTRAINT … SET TAGS`) and to
  the rename path (if the constraint itself was also renamed). Confirm the `require-hint`
  `pureCreate/pureDrop` counts are unaffected (a suppressed pseudo-body-change must not count as a
  pure drop or add).

### Known limitation to document in code + handoff (NOT in scope here)
An FK **referenced column** renamed on the **parent** table is not reconcilable in the child's
`computeTableAlterDiff` — the parent's column renames are computed in the parent's own per-table diff
and aren't visible cross-table in the current single-pass architecture. That case still churns a
drop+recreate (no regression vs. today). Note it as a follow-up; do not attempt a two-pass here.

## Tests (extend `declarative-equivalence.spec.ts`)

Add a `describe('declarative-equivalence: rename without constraint churn')` block. For each, build
the diff via the existing `diffOf(db)` pattern (declare → apply → re-declare-with-rename → diff):

- **CHECK over renamed column**: assert `columnsToRename` has the rename AND
  `constraintsToDrop ?? [] === []` and `constraintsToAdd ?? [] === []`. Apply; assert the CHECK still
  enforces under the new column name; assert the migration DDL contains NO `DROP CONSTRAINT` /
  `ADD …constraint`. Re-diff → idempotent no-op.
- **UNIQUE over renamed column**: same shape; additionally assert the re-add did NOT run (no scan) —
  e.g. seed data that would VIOLATE a fresh UNIQUE add only if it scanned, confirm apply still
  succeeds because the metadata-only rename never re-validates. (Simpler proxy: assert no
  `constraintsToDrop`/`constraintsToAdd`, since the no-scan property follows from not re-adding.)
- **FK whose parent table is renamed** (parent → p2 via `previous_name` table hint): assert the child
  alter has no `constraintsToDrop`/`constraintsToAdd`; the top-level `diff.renames` carries the table
  rename. Apply with `pragma foreign_keys = true`; assert the FK still enforces against the renamed
  parent. Re-diff → idempotent.
- **Genuine body edit ON TOP of a rename still drops+recreates** (regression guard for precedence):
  rename `qty → quantity` AND change `check (quantity > 0)` → `check (quantity >= 0)`; assert
  `constraintsToDrop`/`constraintsToAdd` ARE populated and the new predicate enforces.
- **Idempotence**: every case's second `apply` is a no-op (`diffOf(db).tablesToAlter` deep-equals `[]`).

Optionally add a sqllogic case if a parallel exists; the spec coverage above is sufficient.

## TODO

- [ ] Thread `tableRenames` (filtered to `kind==='table'`) + `schemaName` from `computeSchemaDiff` (call site `schema-differ.ts:310`) into `computeTableAlterDiff`.
- [ ] Add `bodyAst: AST.TableConstraint` to `DeclaredNamedConstraint`; populate in `collectDeclaredNamedConstraints`.
- [ ] Implement `reconciledDeclaredBody(...)` helper (CHECK via `cloneExpr` + `renameColumnInCheckExpression` inverse; UNIQUE/FK via surgical name/table map). Import `cloneExpr` from `planner/mutation/scope-transform.ts` and `renameColumnInCheckExpression` from `schema/rename-rewriter.js`.
- [ ] Replace the body comparison at `schema-differ.ts:~880` to compare the reconciled declared body against `matchedActual.definition`, with the `d.definition === matchedActual.definition` short-circuit.
- [ ] Verify the rename/body precedence (`renamesSuppressedByBodyChange`, `bodyChangedNames`) and `require-hint` `pureCreate/pureDrop` counts are correct after suppression.
- [ ] Add a code comment + a one-line note in the handoff for the FK-referenced-column-on-parent limitation (out of scope).
- [ ] Add the `rename without constraint churn` tests to `declarative-equivalence.spec.ts` (CHECK, UNIQUE, FK-parent-table, genuine-body-edit-on-rename, idempotence).
- [ ] Run `yarn workspace @quereus/quereus test` (and `yarn workspace @quereus/quereus run typecheck` + `lint`) and ensure green; stream output per AGENTS.md.
- [ ] Update `docs/schema.md` (declarative differ / constraint lifecycle section) if it enumerates the body-change rules, noting the rename-reconciliation behavior.
