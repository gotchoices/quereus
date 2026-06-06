description: Suppress redundant FK drop+recreate when only the FK's *referenced column on the parent table* is renamed. Extends the rename-reconciliation in `reconciledDeclaredBody` (FK branch) with cross-table visibility of the parent table's column renames, via a one-pass pre-resolution of every declared table's column renames in `computeSchemaDiff`.
files:
  - packages/quereus/src/schema/schema-differ.ts            # computeSchemaDiff pre-pass + computeTableAlterDiff + reconciledDeclaredBody (FK branch) + inverseRenameConstraintColumns
  - packages/quereus/test/declarative-equivalence.spec.ts   # describe('rename without constraint churn') — add parent-referenced-column cases
  - docs/schema.md                                          # remove the "Known limitation" note (~line 372)
----

## Problem

`reconciledDeclaredBody` reconciles a declared constraint body back to its
pre-rename form so a pure rename does not churn a spurious `DROP CONSTRAINT` +
`ADD CONSTRAINT` on top of the rename already in the diff. It currently handles
CHECK-over-renamed-column, UNIQUE-over-renamed-column, FK-over-renamed-**local**-
column, and FK-whose-**parent-table**-is-renamed.

It does **not** handle an FK whose **referenced column on the parent table** is
renamed:

```
foreign key (pa) references parent(pid)   -- before
foreign key (pa) references parent(key)   -- after (parent col pid → key renamed)
```

The child's `computeTableAlterDiff` sees the declared FK referencing `key` and
the actual catalog FK referencing `pid`, registers a body change, and churns a
drop+recreate of the child FK — re-validating every child row on what is really a
metadata-only parent-column rename.

Severity is low (not a regression; converges correctly), but it wastes an FK
re-validation scan and incurs the non-atomic drop+recreate window the sibling
ticket `constraint-body-change-rename-churn` removed for the other rename shapes.

## Root cause (architecture)

The differ is **single-pass**: each table's alter diff is computed independently
in `computeSchemaDiff`'s table loop. The parent's column renames are resolved
inside the parent's own `computeTableAlterDiff` call (into `diff.columnsToRename`)
and are not threaded to the child's call. `reconciledDeclaredBody` receives only
the **table** renames (`tableRenames`) and the **current table's** column renames
(`diff.columnsToRename`) — it has no visibility into another table's column
renames. Note `ForeignKeyClause.columns` is `string[]` (the referenced parent
columns); the FK's local child columns are the table-constraint-level
`columns: {name}[]`.

## Design (resolved — build to this)

**Pre-pass in `computeSchemaDiff`.** After `tableRenames` is resolved (current
~line 270) and **before** the table loop (~line 307), build a map of every
declared table's column renames keyed by **declared (new) table name, lowercased**:

```
Map<string /* declared table name lower */, ColumnRenameOp[]>
```

Iterate `declaredTables`; for each whose `tableRenames.pairs.get(name)` resolves
to a matched actual, resolve that table's column renames and store them under
`name` (the map's declared key is already lowercased). Tables with no matched
actual (pure creates) contribute nothing.

Keying by the **declared (new)** table name is correct because an FK's
`foreignKey.table` carries the parent's **declared** name at diff time — that is
the lookup key the child uses. It also makes a **self-referential FK** fall out
for free: the parent is the current table, so `map.get(currentTable)` returns the
same renames as `diff.columnsToRename`.

Extract the column-rename resolution that `computeTableAlterDiff` already does
(building `declaredColumns`/`actualColumns` maps + the `resolveRenames` call,
current lines ~880-901) into a small helper so the pre-pass and the in-loop call
share one code path. Decision: the pre-pass computes **only** `ColumnRenameOp[]`
for the map; `computeTableAlterDiff` keeps its existing internal `resolveRenames`
call (it needs the full `{renames, pairs, consumedActuals}` for add/drop/alter).
The current table's renames are thus resolved twice — accept it: `resolveRenames`
over a table's columns is O(columns) with no I/O, and threading the full result
through the loop for a micro-optimization would widen the blast radius. Document
this tradeoff in a comment at the pre-pass.

**Thread the map** through `computeTableAlterDiff` (new parameter) into the
`reconciledDeclaredBody` call (current ~line 995).

**FK branch of `reconciledDeclaredBody`.** After cloning `foreignKey.columns`,
look up the parent's column renames by `clone.foreignKey.table.toLowerCase()` (the
declared parent name, **before** the existing table inverse-rename) and inverse-
rename the referenced parent columns. `foreignKey.columns` is `string[]`, so add a
string-list variant of `inverseRenameConstraintColumns` (or generalize it) that
maps each entry from its NEW name back to its OLD name with **case-insensitive**
matching — symmetric with the existing `{name}[]` helper. Keep the parent
**table** inverse-rename that already follows. Both rewrites are independent on the
clone, so a parent-table-rename + parent-column-rename in the same diff reconciles
both (look up parent col renames by the new parent name, then rewrite the table
name to old).

When the parent declared name is absent from the map (e.g. a freshly created
parent), the lookup returns undefined and the FK branch behaves exactly as today.

## Edge cases & interactions

- **Pure parent-column rename** → emits ONLY the parent's `RENAME COLUMN`; no
  child FK drop/add. FK still enforces; idempotent re-apply produces no alter.
- **Parent-table rename + parent-column rename together** → emits the table rename
  + the parent's column rename; child FK not churned. (Build the test so the child
  references the renamed parent under both new names.)
- **Self-referential FK** whose referenced column is renamed → reconciled via the
  current-table entry in the map; no churn. Worth an explicit test.
- **Genuine FK body edit layered on a parent-column rename** (e.g. add/alter
  `on delete cascade`, or change the local column too) → still differs after
  reconciliation → drop+recreate preserved. Precedence guard.
- **Elided referenced-column list** (`references parent` with no column list) →
  the parent column never appears in the FK body, so nothing to reconcile and no
  churn either way; reconciliation must not synthesize a column list. (Canonical
  normalization already collapses the elided list — confirm no regression.)
- **Multi-column FK** where only one referenced parent column is renamed → only
  that entry rewritten; the others pass through.
- **Case-insensitivity**: the parent-column inverse-rename must match new-name
  case-insensitively (the catalog `definition` may differ in case).
- **Canonical-string symmetry**: declared side renders via `ast-stringify`'s
  `constraintBodyToCanonicalString`; actual side via `ddl-generator`'s
  `constraintToCanonicalDDL`. Verify both render the referenced-parent-column list
  identically so the reconciled string compares byte-equal (the existing FK
  parent-table and local-column cases rely on the same symmetry).
- **`require-hint` policy**: a pure parent-column rename now produces neither a
  constraint add nor drop on the child, so it must not trip the constraint
  add/drop guard (it didn't trip before for the reconciled cases — verify the
  child alter has empty `constraintsToAdd`/`constraintsToDrop`).
- **No other callers**: `computeTableAlterDiff`, `reconciledDeclaredBody`, and
  `inverseRenameConstraintColumns` are all private to `schema-differ.ts` — only
  internal call sites change.

## Tests (extend `describe('declarative-equivalence: rename without constraint churn')`)

Mirror the existing FK tests' structure (`pragma foreign_keys = true`, declare →
apply → seed rows → re-declare with rename hint → assert on `diffOf(db)` and
`generateMigrationDDL`, then apply and assert enforcement + idempotence):

- **Parent referenced column renamed** (`parent.pid → parent.key`, child FK
  references `parent(key)`): child alter has empty `constraintsToDrop`/
  `constraintsToAdd`; the parent alter carries `columnsToRename`
  `[{ oldName: 'pid', newName: 'key' }]`; DDL contains the parent `RENAME COLUMN`
  and **no** `DROP CONSTRAINT` / `ADD ...constraint` on the child. After apply: FK
  rejects an orphan, accepts a valid reference; re-apply yields no alter.
- **Parent table + parent column renamed together**: child FK references the
  doubly-renamed parent; top-level `renames` carries the table rename, parent alter
  carries the column rename, child FK not churned; enforcement holds; idempotent.
- **Self-referential FK referenced column renamed**: single table with an FK to
  itself whose referenced (parent==self) column is renamed; no FK churn.
- **REGRESSION — genuine FK body edit layered on a parent-column rename** still
  drops+recreates the child FK (e.g. rename `parent.pid → key` AND add
  `on delete cascade` to the child FK): child `constraintsToDrop` = `['fk']`,
  `constraintsToAdd.length` = 1.

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
  (stream — never silent-redirect). The new cases live in
  `test/declarative-equivalence.spec.ts`.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- A store-path re-run (`yarn test:store`) is **not** required for this ticket —
  the change is in the differ (catalog-only diff computation), not a module's
  `alterTable`; the existing FK rename tests already cover the differ↔emit wiring.

## TODO

- Extract the per-table column-rename resolution from `computeTableAlterDiff` into
  a shared helper returning `ColumnRenameOp[]` (or the full `resolveRenames`
  result; the pre-pass takes `.renames`).
- Add the pre-pass in `computeSchemaDiff` building
  `Map<declaredTableNameLower, ColumnRenameOp[]>`, with the double-resolution
  tradeoff documented inline.
- Add the new map parameter to `computeTableAlterDiff` and forward it to the
  `reconciledDeclaredBody` call.
- Add a string-list inverse-rename helper (or generalize
  `inverseRenameConstraintColumns`) and apply it to `clone.foreignKey.columns` in
  the FK branch, keyed by the declared parent table name; preserve the existing
  parent-table inverse-rename.
- Remove the "KNOWN LIMITATION" note from `reconciledDeclaredBody`'s JSDoc and the
  FK-case comment, and update the JSDoc to list the parent-referenced-column case
  as handled.
- Remove the "**Known limitation:** an FK *referenced column* renamed on the
  *parent* table…" sentence in `docs/schema.md` (~line 372) and adjust the
  surrounding sentence to state FK reconciliation now also covers the referenced
  parent column.
- Add the four tests above to `test/declarative-equivalence.spec.ts`.
- Run build + test + lint; confirm idempotent re-apply and FK enforcement.
