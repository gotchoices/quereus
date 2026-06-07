description: Schema differ now detects index body drift — a name-matched declared index whose UNIQUE-ness, column set/order/direction, or partial WHERE predicate changed drops+recreates (mirroring the MV bodyHash and named-constraint `definition` paths) instead of silently no-op'ing.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # createIndexBodyToCanonicalString + canonicalIndexedColumnsToString + indexedColumnBareName
  - packages/quereus/src/schema/ddl-generator.ts         # indexToCanonicalDDL
  - packages/quereus/src/schema/catalog.ts               # CatalogIndex.definition (required) + populated in indexSchemaToCatalog
  - packages/quereus/src/schema/schema-differ.ts         # index loop body comparison + indexBodyRecreates require-hint exclusion (~L431-478)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # "declarative differ stability" describe — now 17 cases
  - docs/schema.md                                       # "#### Index body-change detection (drop+recreate)" subsection
----

# Complete: schema differ index body-drift detection

## What shipped

`computeSchemaDiff` previously matched indexes by name and compared only their
**tags**; an in-place edit to a declared index (flipped `UNIQUE`, changed column
set/order/direction, or added/changed/removed partial `WHERE`) produced **no
migration**. This closes that gap by the same pattern the materialized-view
`bodyHash` and named-constraint `definition` paths already use:

1. A shared canonical body renderer `createIndexBodyToCanonicalString`
   (`ast-stringify.ts`) renders `[unique ]index (<cols>)[ where <expr>]` —
   excluding name, `on <table>`, `if not exists`, tags, and (deliberately)
   collation. A collation-excluding column renderer extracts the bare column name
   from both indexed-column forms (plain `col.name` and the parser's
   collate-folded `collate(col)` form) and appends ` desc` only when descending.
2. The actual side (`ddl-generator.ts` `indexToCanonicalDDL`) lifts the stored
   `IndexSchema` into a minimal `CreateIndexStmt` and renders it through the same
   function, so both sides are byte-comparable.
3. `CatalogIndex.definition` (now **required**) carries the actual rendering,
   populated only in `indexSchemaToCatalog`.
4. The differ index loop compares the declared body against
   `matchedActual.definition`; on drift it drops the actual (pre-rename) name and
   recreates the declared `create [unique] index …` carrying declared tags, then
   `continue`s (no separate `SET TAGS`). A body-change recreate increments
   `indexBodyRecreates`, subtracted from both `enforceRequireHint('index', …)`
   counts so a recreate never falsely trips the unhinted-rename guard.

## Review findings

### Scope of review
Read the full implement diff (`b3e02819`) before the handoff. Scrutinized the
canonical renderer, the actual-side lift, the catalog field, the differ loop, the
require-hint accounting, and the docs. Verified the symmetry invariants the whole
design rests on (both sides must render identical strings for equal indexes).

### Verified correct (no action)
- **Predicate symmetry** — both `buildIndexSchema` (live) and `importIndex`
  (round-trip) store `predicate: stmt.where` (the raw parsed AST); the declared
  side compares the raw `stmt.where`. Both render via `expressionToString`, so a
  semantically-identical predicate does not churn (and the test asserts it).
- **Direction symmetry** — the parser preserves `col.direction` on *both* the
  plain `{name, direction}` and the collate-folded `{expr, direction}` indexed-
  column forms (parser.ts `indexedColumn()`), and the actual-side lift reads the
  correct field `IndexColumnSchema.desc` (table.ts:323). asc / explicit-asc /
  default all collapse to "no suffix" on both sides; only `desc` emits ` desc`.
  A wrong lift field would have gone uncaught — see the new test below.
- **require-hint exclusion is exact** — `enforceRequireHint` throws iff
  `creates>0 && drops>0`; each body recreate contributes exactly +1 to both
  `indexesToCreate` and `indexesToDrop` and +1 to `indexBodyRecreates`, so
  subtracting it from both is precise. A genuine unhinted rename layered on a
  recreate still trips (asserted); pure-create-only / pure-drop-only after
  subtraction correctly does not.
- **`definition` made required is safe** — grep confirms `indexSchemaToCatalog`
  is the *only* `CatalogIndex` construction site (catalog.ts); no store /
  isolation / test literal builders. `CatalogIndex` is a quereus-internal type.
- **Implicit covering indexes excluded** — `collectSchemaCatalog` skips hidden
  implicit covering structures (catalog.ts:149) unless `expose_implicit_index`,
  so they never name-match and never participate. Doc claim accurate.
- **Collation exclusion is the intended trade-off** (the handoff flagged this for
  reviewer confirmation) — the actual side stores a *resolved* per-column
  collation (always explicit) while the declared index inherits collation from
  the table column (no collation on the index AST). Comparing it would churn a
  spurious recreate on an inherited-`NOCASE` unique index; the
  `inherited-NOCASE re-declare → empty diff` test demonstrates exactly that.
  **Confirmed correct** to exclude; deferred (with concurrent rename
  reconciliation) to `schema-differ-index-collation-and-rename-reconciliation`.
- **Docs** (`docs/schema.md` new subsection) read accurately against the code.

### Minor — fixed inline (this pass)
- **Test floor strengthened** (`index-ddl-roundtrip.spec.ts`, +2 cases → 17):
  - *desc-baseline no-op stability* — every existing desc test starts from an
    *asc* baseline, so none exercised the actual side already carrying `desc`. A
    broken `IndexColumnSchema.desc` lift would have produced spurious churn while
    all prior tests still passed. New test declares a desc index, applies, and
    re-declares it verbatim → asserts empty diff. (Field is correct; test now
    locks the symmetry.)
  - *column-set change* — `(name)` → `(email)` recreates (prior tests covered
    reorder and direction flip but not a genuine different-column swap).

  Both pass; full quereus suite re-run green (5189 passing, 9 pending).

### Major — filed as new ticket (not fixed inline)
- **Canonical-body column-name case churn** →
  `tickets/backlog/canonical-body-column-name-case-normalization.md`. The
  canonical renderers emit bare column-name identifiers via `quoteIdentifier`,
  which **preserves case**, while the differ resolves column names
  case-insensitively everywhere else (`pkSequencesEqual` and column lookups use
  `.toLowerCase()`). A declared index whose column reference differs in *case*
  from the column *definition* (`Email` defined, `email` indexed) renders
  byte-unequal vs the actual catalog → spurious drop+recreate on every diff,
  never converging. This is **pre-existing and family-wide** — the named-
  constraint UNIQUE / FK / referenced-column and PK canonical paths share the
  exact same `quoteIdentifier(col.name)` behavior — and was inherited by the new
  index path. Not fixed inline because the correct fix is a shared normalization
  across index + constraint + PK canonical bodies (an index-only patch would
  leave the constraint path inconsistent) and must first settle quoted-identifier
  case semantics. Low severity (the recreate is correct, just unnecessary work).

### Known gaps acknowledged (not blocking)
- **Multi-schema (non-`main`) drift not directly tested** — the body render is
  schema-agnostic (qualification never enters the body) and the recreate reuses
  `applyIndexDefaults`; verified by reasoning, no dedicated test.
- **Store backend not run** — only `yarn test` (memory). `definition` population
  flows through the module-agnostic `collectSchemaCatalog` / `indexToCanonicalDDL`;
  `yarn test:store` is out-of-band per AGENTS.md. No store-specific surface
  touched.
- **Drop+recreate not atomic** on the memory backend — same as the existing
  constraint/MV body-change paths; consistent, not a regression.
- **Pure index rename (no body change) still emits no DDL** — pre-existing
  (indexes have no rename primitive); unchanged here. A rename *with* a body
  change correctly drop+recreates.

## Validation
- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0).
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus test` → **5189 passing, 9 pending** (the 9
  pending are pre-existing; no failures, no regressions).
- Targeted `declarative differ stability` describe → **17 passing** (15 from
  implement + 2 added in review).

No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
