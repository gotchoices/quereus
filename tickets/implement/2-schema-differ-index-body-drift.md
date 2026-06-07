description: The declarative schema differ matches indexes by name and compares only their tags, so an in-place edit to a declared index's UNIQUE-ness, column set/order/direction, or partial WHERE predicate (same name) produces no migration. Add canonical-body drift detection that drops+recreates a name-matched index whose body changed, mirroring the materialized-view bodyHash path.
prereq: declare-schema-index-where-clause
files:
  - packages/quereus/src/schema/schema-differ.ts     # index diff loop (~L433-445); require-hint (~L452); MV body path model (~L410-426); constraint precedence model (~L1062-1096)
  - packages/quereus/src/emit/ast-stringify.ts        # add createIndexBodyToCanonicalString; existing createIndexToString (~L810), indexedColumnsToString (~L796), constraintBodyToCanonicalString model (~L1313-1334)
  - packages/quereus/src/schema/ddl-generator.ts      # add indexToCanonicalDDL; constraintToCanonicalDDL model (~L155-161); generateIndexDDL (~L104)
  - packages/quereus/src/schema/catalog.ts            # CatalogIndex (~L66-71) add `definition`; indexSchemaToCatalog (~L303-314)
  - packages/quereus/src/schema/table.ts              # IndexSchema type (~L329-343): columns(index/desc/collation), unique, predicate, tags
  - packages/quereus/test/index-ddl-roundtrip.spec.ts # "declarative differ stability" describe (~L316) — extend with drift cases
----

# Schema differ: detect index body drift (UNIQUE / columns / partial predicate)

## Problem

`computeSchemaDiff` (schema-differ.ts) resolves indexes by name (or rename hint).
For a name-matched index the only further check is `tagsDrifted(...)` →
`indexTagsChanges` (an in-place `ALTER INDEX … SET TAGS`). Unlike materialized
views — which recompute a body hash and drop+recreate on body change (~L410-426)
— the index loop (~L433-445) never compares the index **body**: not the column
list, not column direction, not `UNIQUE`, not the partial `WHERE` predicate.

So editing a `declare schema { ... }` index in place (same name) to add/remove
`UNIQUE`, change columns/order/direction, or change/add/remove its `WHERE`
predicate emits **no migration**; the applied catalog silently keeps the old
shape. This is a correctness gap in the declarative apply path, and the existing
"declarative differ stability" test (~L316) documents it as accepted behavior —
that test must be updated to assert the new drop+recreate.

`generateIndexDDL` (ddl-generator.ts) already emits a *lossless* actual-side DDL
(`CREATE [UNIQUE] INDEX … [WHERE …]`), so the live catalog already carries the
information drift detection needs; the differ simply never looks at it.

## Design

Mirror the constraint body-comparison architecture (the established pattern for
"name unchanged, body changed → drop+recreate"): render a **canonical body**
string for both the declared side (AST) and the actual side (lifted from
`IndexSchema`) through one shared renderer, store the actual rendering on the
catalog record, and compare in the differ.

### 1. Shared canonical body renderer (ast-stringify.ts)

Add `createIndexBodyToCanonicalString(stmt: AST.CreateIndexStmt): string`,
modeled on `constraintBodyToCanonicalString` (~L1313). It renders **only the
body** — excluding the index name, table reference, `if not exists`, and
`with tags (...)` (tags are a separate diff channel: `ALTER INDEX … SET TAGS`):

```
[unique ]index (<canonical-cols>)[ where <expr>]
```

- `unique` token emitted iff `stmt.isUnique`.
- Columns rendered by a **collation-excluding** canonical column renderer (do NOT
  reuse `indexedColumnsToString`, which emits collation): for each column emit the
  bare column name + ` desc` only when descending. Collation is intentionally
  **excluded from the comparison** this pass (see Decision below).
- The bare column name must be extracted from both indexed-column forms: a plain
  `col.name`, and the parser's collate-folded form where `col.name` is undefined
  and `col.expr` is a `collate` expression over a column ref (unwrap to
  `expr.expr.name` — see the `indexColumnName` helper in
  index-ddl-roundtrip.spec.ts ~L41 for the exact shape). A genuine
  expression-index column (no resolvable name) falls back to
  `expressionToString(col.expr)`; such indexes are rejected on import anyway, so
  they never name-match a real actual.
- `where` emitted via `expressionToString(stmt.where)` when present — the same
  emitter the CHECK-constraint body comparison relies on for deterministic,
  re-parseable, byte-comparable output.

### 2. Actual-side canonical body (ddl-generator.ts)

Add `indexToCanonicalDDL(indexSchema: IndexSchema, tableSchema: TableSchema):
string`, modeled on `constraintToCanonicalDDL` (~L155). Lift the stored
`IndexSchema` into a minimal `AST.CreateIndexStmt` — columns mapped
`{ name: tableSchema.columns[col.index].name, direction: col.desc ? 'desc' :
undefined }`, `isUnique: !!indexSchema.unique`, `where: indexSchema.predicate` —
then return `createIndexBodyToCanonicalString(stmt)`. Lifting to AST and rendering
through the *same* ast-stringify function (rather than hand-building a string) is
what keeps the two sides byte-comparable and DRY, exactly as the constraint path
does via `schemaConstraintToTableConstraint`.

### 3. Catalog field (catalog.ts)

Add a required `definition: string` to `CatalogIndex` (mirroring
`CatalogTable.namedConstraints[].definition` and `CatalogMaterializedView.
bodyHash`), populated in `indexSchemaToCatalog` (~L303) via
`indexToCanonicalDDL(indexSchema, tableSchema)`. No test constructs a
`CatalogIndex` literal today (all use `indexes: []`), so making it required is
safe — but grep `CatalogIndex` / index-literal builders to be sure before
finalizing.

### 4. Differ loop (schema-differ.ts ~L433-445)

Import `createIndexBodyToCanonicalString` (alongside the existing
`constraintBodyToCanonicalString` import). Replace the index loop with:

```ts
let indexBodyRecreates = 0; // pure-create/-drop counts for require-hint exclusion
for (const [name, declaredIndex] of declaredIndexes) {
  const matchedActual = indexRenames.pairs.get(name);
  if (!matchedActual) {
    const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
    diff.indexesToCreate.push(createIndexToString(effectiveStmt));
    continue;
  }
  // Body comparison (canonical: name / tags / collation excluded). Schema
  // qualification does not affect the body render, so compare the raw declared stmt.
  const declaredBody = createIndexBodyToCanonicalString(declaredIndex.indexStmt);
  if (declaredBody !== matchedActual.definition) {
    // Body drift → drop old + recreate (the recreate carries declared tags), the
    // same drop+recreate shape MVs use; never also emit SET TAGS for this index.
    diff.indexesToDrop.push(matchedActual.name);
    const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
    diff.indexesToCreate.push(createIndexToString(effectiveStmt));
    indexBodyRecreates++;
    continue;
  }
  // Body unchanged → in-place tag change (pure name match only, as before).
  if (matchedActual.name.toLowerCase() === name && tagsDrifted(declaredIndex.indexStmt.tags, matchedActual.tags)) {
    diff.indexTagsChanges.push({ name: declaredIndex.indexStmt.index.name, tags: desiredTagSet(declaredIndex.indexStmt.tags) });
  }
}
```

The drop targets `matchedActual.name` and the create carries the declared
(post-rename) name, so a body change on a **rename-matched** index resolves to a
correct drop+recreate that supersedes the (currently no-op) non-table rename op.

### 5. require-hint policy (schema-differ.ts ~L452)

`enforceRequireHint('index', creates, drops)` counts a body-change recreate as
both a create and a drop, which would falsely trip the unhinted-rename guard. The
constraint path excludes body recreates from its pure counts (~L1066-1069,
~L1120-1125). Mirror that: subtract `indexBodyRecreates` from both arguments —
`enforceRequireHint('index', diff.indexesToCreate.length - indexBodyRecreates,
diff.indexesToDrop.length - indexBodyRecreates)`.

### Decision: collation and concurrent column/table renames are excluded this pass

The ticket's "Expected behavior" lists collation among body attributes, but
including it cleanly is a false-churn hazard: the actual side stores a *resolved*
per-column collation (always explicit, including `BINARY`), while the declared
side inherits collation from the table column (no collation on the index AST) and
defaults to `BINARY`. Making the two render byte-identically requires resolving
declared inheritance against the (possibly also-changing) declared table column
collation — materially more plumbing and risk than the core fix warrants.

Likewise, this pass does **not** reconcile an index body against a *concurrent*
column or table rename in the same diff (the way `reconciledDeclaredBody` does for
constraints). A same-named index over a column renamed in the same apply would
render the new name on the declared side vs the old name on the actual side and
thus produce a (harmless-but-unnecessary) drop+recreate — churn, not corruption.

Both are deferred to `schema-differ-index-collation-and-rename-reconciliation`
(backlog). The core, high-value, low-risk drift signals — UNIQUE-ness, column
set/order, direction, and partial predicate — are fully covered here.

## Edge cases & interactions

- **UNIQUE flip both directions** — plain→unique and unique→plain each
  drop+recreate. The recreate DDL carries (or omits) `UNIQUE` per the declaration.
- **Partial predicate add / remove / change** (needs the prereq grammar):
  declared `where active = 1` vs actual none → recreate; declared none vs actual
  `where active = 1` → recreate; declared `where active = 1` vs actual
  `where active = 0` → recreate. A semantically-identical predicate must NOT churn
  (rely on `expressionToString` determinism, same as CHECK bodies).
- **Column set / order / direction** — added/removed/reordered columns and an
  `asc`↔`desc` flip on a column each drop+recreate.
- **No-op stability** — re-declaring an unchanged index (incl. one whose
  actual-side DDL now carries `UNIQUE` or an inherited `COLLATE`) must produce an
  empty diff. This is the existing "declarative differ stability" assertion;
  collation exclusion is what keeps an inherited-`NOCASE` unique index from
  churning.
- **Tags-only change** — body identical, tags drifted → `indexTagsChanges` (SET
  TAGS), NOT a recreate. Mutually exclusive with a body recreate per object.
- **Body change + tags change together** — body drift wins: drop+recreate carries
  the declared tags; no separate SET TAGS (mirror the MV precedence at ~L417-424).
- **require-hint policy** — a body-change recreate must NOT trip
  `enforceRequireHint('index', …)`; a genuine unhinted create+drop pair (distinct
  names, no body match) still must.
- **Rename-matched + body change** — drop(old)+recreate(new) supersedes the
  no-op index rename op; assert no duplicate/contradictory statements.
- **Hidden implicit covering indexes** — the UNIQUE-constraint-backed secondary
  BTree is excluded from the catalog unless `quereus.expose_implicit_index`
  (catalog.ts ~L130-141, `implicitCoveringIndexExposure`); confirm body-drift
  detection never operates on a hidden implicit index (it isn't in
  `actualCatalog.indexes`, so it can't name-match — verify no regression).
- **Migration ordering** — `generateMigrationDDL` already drops indexes
  (~L1449) before creating them (~L1458), so a recreate is correctly ordered drop
  → create. Confirm the emitted statement pair for a body change.
- **CatalogIndex literal builders** — adding a required `definition` field could
  break any hand-built `CatalogIndex` in tests/store packages; grep before
  finalizing (none found in `packages/quereus/test`, but check store/isolation).

## TODO

- Add `createIndexBodyToCanonicalString` to ast-stringify.ts (collation-excluding
  canonical column renderer; unwrap collate-folded column refs; emit
  `[unique ]index (cols)[ where expr]`).
- Add `indexToCanonicalDDL(indexSchema, tableSchema)` to ddl-generator.ts (lift
  `IndexSchema` → minimal `CreateIndexStmt`, render via the shared renderer).
- Add required `definition` to `CatalogIndex` (catalog.ts); populate in
  `indexSchemaToCatalog` via `indexToCanonicalDDL`.
- Update the index loop in `computeSchemaDiff` to compare canonical bodies and
  drop+recreate on drift (suppressing the tag change); track `indexBodyRecreates`.
- Subtract `indexBodyRecreates` from the `enforceRequireHint('index', …)` counts.
- Extend the "declarative differ stability" describe in
  index-ddl-roundtrip.spec.ts (~L316):
  - **Update** the existing UNIQUE no-op test → re-declare a plain index as
    `UNIQUE` (same name) and assert `indexesToDrop` + `indexesToCreate` contain
    the recreate (it is no longer empty).
  - Plain→unique and unique→plain recreate.
  - Partial-predicate add / change / remove recreate (uses the prereq WHERE
    grammar); semantically-identical predicate = no churn.
  - Column reorder / direction flip recreate.
  - Unchanged re-declare = empty diff (no-op stability, incl. an inherited-NOCASE
    unique index — collation exclusion).
  - Tags-only change = `indexTagsChanges`, no recreate.
  - Body change + tags change = single drop+recreate, no SET TAGS.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus
  run lint`; stream with `2>&1 | tee /tmp/differ.log; tail -n 120 /tmp/differ.log`.
