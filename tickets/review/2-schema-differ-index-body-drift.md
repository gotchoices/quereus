description: Review the schema differ's new index body-drift detection — a name-matched declared index whose UNIQUE-ness, column set/order/direction, or partial WHERE predicate changed now drops+recreates (mirroring the MV bodyHash and constraint `definition` paths), instead of silently no-op'ing as before.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # createIndexBodyToCanonicalString + canonicalIndexedColumnsToString + indexedColumnBareName (after createIndexToString ~L827)
  - packages/quereus/src/schema/ddl-generator.ts         # indexToCanonicalDDL (after generateIndexDDL ~L141); import of the renderer
  - packages/quereus/src/schema/catalog.ts               # CatalogIndex.definition (required) + populated in indexSchemaToCatalog
  - packages/quereus/src/schema/schema-differ.ts         # index loop body comparison + indexBodyRecreates require-hint exclusion (~L431-453)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # "declarative differ stability" describe — 15 drift/no-op/tags/require-hint/convergence cases
  - docs/schema.md                                       # new "#### Index body-change detection (drop+recreate)" subsection
----

# Review: schema differ index body-drift detection

## What changed & why

Before this work, `computeSchemaDiff` matched indexes by name and compared only
their **tags**. An in-place edit to a declared index (same name) that flipped
`UNIQUE`, changed the column set/order/direction, or added/changed/removed a
partial `WHERE` predicate produced **no migration** — the applied catalog
silently kept the old shape. This mirrors the gap the materialized-view
`bodyHash` path and the named-constraint `definition` path already close for
their object kinds; this ticket closes it for indexes by the same pattern:

1. **One shared canonical body renderer** (`ast-stringify.ts`
   `createIndexBodyToCanonicalString`) renders `[unique ]index (<cols>)[ where
   <expr>]` — excluding index name, `on <table>`, `if not exists`, and tags.
   A collation-**excluding** column renderer (`canonicalIndexedColumnsToString`)
   emits the bare column name + ` desc` only when descending; it unwraps the
   parser's collate-folded column form (`col.expr` a `collate` over a column ref)
   via `indexedColumnBareName`.
2. **Actual-side lift** (`ddl-generator.ts` `indexToCanonicalDDL`) lifts the
   stored `IndexSchema` into a minimal `CreateIndexStmt` and renders it through
   the *same* function — byte-comparable with the declared side, exactly as
   `constraintToCanonicalDDL` does via `schemaConstraintToTableConstraint`.
3. **Catalog field** (`catalog.ts`): `CatalogIndex.definition` (now **required**)
   carries the actual rendering, populated in `indexSchemaToCatalog`. The only
   construction site is `indexSchemaToCatalog` (verified by grep — no store /
   isolation literal builders), so making it required is safe.
4. **Differ loop** (`schema-differ.ts`): for a name-/rename-matched index, compare
   `createIndexBodyToCanonicalString(declaredIndex.indexStmt)` against
   `matchedActual.definition`. On drift → push `matchedActual.name` to
   `indexesToDrop` and the declared `create [unique] index …` (carrying declared
   tags) to `indexesToCreate`; `continue` so no separate `SET TAGS`. Body
   unchanged → the prior in-place tag path (pure name match only). A
   body-change recreate increments `indexBodyRecreates`, which is subtracted from
   both `enforceRequireHint('index', …)` counts (mirrors the constraint path) so a
   recreate doesn't falsely trip the unhinted-rename guard.

## Deliberate exclusions (deferred — NOT bugs)

Per the plan's "Decision" section, two body attributes are intentionally **out of
scope** and deferred to the existing backlog ticket
`schema-differ-index-collation-and-rename-reconciliation`:

- **Collation** — the actual side stores a *resolved* per-column collation
  (always explicit, incl. `BINARY`/inherited `NOCASE`), while the declared index
  inherits collation from the table column (no collation on the index AST).
  Comparing it would churn a spurious recreate on an inherited-`NOCASE` unique
  index. Excluding it is what keeps the no-op-stability case stable. **The
  reviewer should confirm this is the intended trade-off**, not an oversight.
- **Concurrent column/table rename reconciliation** — a same-named index over a
  column renamed *in the same diff* renders the new name (declared) vs the old
  name (actual) and so produces a harmless-but-unnecessary drop+recreate (churn,
  not corruption). The constraint path has `reconciledDeclaredBody`; the index
  path deliberately does not, this pass.

## How to validate / exercise

Primary surface is `computeSchemaDiff(declared, actual, policy?)`. The test helper
`diffIndexEdit(baseline, modified, policy?)` applies `baseline` as schema `main`
(so the actual table round-trips with zero churn) then diffs a fresh `modified`
declaration. Cases covered in `index-ddl-roundtrip.spec.ts` →
`describe('… declarative differ stability')` (15 tests, all passing):

- **No-op stability**: unchanged re-declared UNIQUE index → empty diff (and the
  actual-side DDL carries `UNIQUE`); inherited-`NOCASE` unique index re-declare →
  empty diff (collation-exclusion guard).
- **UNIQUE flip**: plain→unique and unique→plain each drop+recreate.
- **Partial predicate**: add / change / remove each recreate; a
  semantically-identical predicate does **not** churn (relies on
  `expressionToString` determinism — the live & import `createIndex` paths both
  store the raw `stmt.where` AST, verified at manager.ts buildIndexSchema/importIndex).
- **Columns**: reorder and `asc`→`desc` direction flip each recreate.
- **Tags**: tags-only change → `indexTagsChanges` (no recreate); body change +
  concurrent tags change → single drop+recreate carrying declared tags, **no**
  separate `SET TAGS`.
- **require-hint**: a body-change recreate does **not** trip the policy; a genuine
  unhinted create+drop of two distinctly-named indexes still throws.
- **End-to-end convergence**: declare plain index → apply; re-declare UNIQUE →
  apply (the migration's DROP + CREATE UNIQUE actually execute); assert the live
  index is now UNIQUE and a third diff is empty. This is the only test that runs
  the generated migration rather than just asserting the diff shape.

## Known gaps / where to push (tests are a floor)

- **Multi-schema (non-`main`) drift is not directly tested.** The body comparison
  is schema-agnostic (qualification never enters the body render) and the recreate
  reuses the existing `applyIndexDefaults` create path, but no test exercises a
  non-`main` schema specifically. Low risk; a reviewer could add one.
- **Store backend not run.** Only `yarn test` (memory) was run — the default.
  `definition` population goes through the module-agnostic `collectSchemaCatalog`
  /`indexToCanonicalDDL`, so the store path uses the same code, but `yarn
  test:store` was not run (slow; out-of-band per AGENTS.md). No store-specific
  surface was touched.
- **Drop+recreate is not atomic** on the memory backend (same as the existing
  constraint/MV body-change paths): a failed recreate after a successful drop
  leaves the index gone. Not separately tested; consistent with prior behavior.
- **Pure index rename (no body change) still emits no DDL** — pre-existing
  limitation (indexes have no rename primitive; `generateMigrationDDL` emits
  nothing for an index `RenameOp`). Unchanged by this work; a reviewer should not
  expect a rename-only scenario to produce a migration. A rename *with* a body
  change now correctly drop+recreates (drop targets the old name, create carries
  the new), superseding the no-op rename op — covered by the loop logic but not by
  a dedicated test (the rename-hint plumbing makes a minimal repro verbose).
- **Hidden implicit covering indexes**: excluded from `actualCatalog.indexes`, so
  they cannot name-match — verified by reasoning + the full suite passing, not a
  dedicated regression test.

## Validation run

- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus test` → **5186 passing, 9 pending** (no
  regressions; the 9 pending are pre-existing).
- `yarn workspace @quereus/quereus run lint` → clean.
- Targeted: `index-ddl-roundtrip.spec.ts` → 33 passing (incl. the 15 differ cases).

No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
