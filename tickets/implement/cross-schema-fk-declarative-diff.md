description: Make the declarative schema differ (DIFF/APPLY SCHEMA) symmetric for cross-schema foreign keys — no spurious churn, real parent-schema changes detected.
prereq: cross-schema-fk-parse-enforce
files:
  - packages/quereus/src/emit/ast-stringify.ts        # constraintBodyToCanonicalString (:1694), canonicalForeignKeyClause (:1616), foreignKeyClauseTail (:1714)
  - packages/quereus/src/schema/ddl-generator.ts       # constraintToCanonicalDDL (:302), schemaConstraintToTableConstraint (:338)
  - packages/quereus/src/schema/schema-differ.ts        # collectDeclaredNamedConstraints (:1424), canonicalizeDeclaredConstraintBody (:1598)
  - packages/quereus/test/                              # DIFF/APPLY SCHEMA coverage
difficulty: medium
----

# Cross-schema FK: declarative-differ canonical symmetry

After `cross-schema-fk-parse-enforce`, cross-schema FKs parse, enforce, and
persist. This ticket makes the **declarative differ** (`DIFF SCHEMA` /
`APPLY SCHEMA`) treat them correctly: a cross-schema FK that is unchanged must not
churn a drop+recreate, and a genuine parent-schema change must be detected.

## The asymmetry to fix

The differ compares a constraint's **canonical body string**
(`constraintBodyToCanonicalString`, `ast-stringify.ts:1694`) on two sides:

- **Actual catalog side** — `constraintToCanonicalDDL` (`ddl-generator.ts:302`) →
  `schemaConstraintToTableConstraint`, built from `c.referencedSchema`, which is
  **always populated** (and, per the prereq, emits the qualifier only when it
  differs from the child schema).
- **Declared side** — the parsed user AST `bodyAst`
  (`collectDeclaredNamedConstraints`, `schema-differ.ts:1431`; and the
  rename-inversion clone, `canonicalizeDeclaredConstraintBody`, `:1598`). Here
  `foreignKey.schema` is **exactly what the user wrote**: `undefined` for
  `references t`, `'main'` for an explicit `references main.t`, `'s2'` for
  `references s2.t`.

So `references main.t` declared on a child **in main** (schema `'main'`)
canonicalizes with `schema: 'main'`, but the actual side elides it (parent ==
child schema) → `schema: undefined`. Two byte-different keys for the same
constraint → spurious drop+recreate. The prereq deliberately left this to here.

## Design

Normalize **both sides** with the rule: *the FK schema qualifier is canonical iff
it differs from the child table's schema; an explicit qualifier equal to the
child schema is elided to `undefined`.* This requires the **child schema name** at
canonicalization time.

`canonicalForeignKeyClause` / `constraintBodyToCanonicalString` currently take only
the constraint AST. Thread an optional child-schema argument through:

- `constraintBodyToCanonicalString(tc, childSchemaName?)` — when building the FK
  arm, pass `childSchemaName` into `canonicalForeignKeyClause`.
- `canonicalForeignKeyClause(fk, childSchemaName?)` — elide:
  `schema: fk.schema && fk.schema.toLowerCase() !== childSchemaName?.toLowerCase()
  ? fk.schema.toLowerCase() : undefined`.

Supply the child schema at both call sites:

- **Actual side**: `constraintToCanonicalDDL(kind, constraint, tableSchema)` already
  has `tableSchema.schemaName` — pass it through.
- **Declared side**: `collectDeclaredNamedConstraints(declaredTable, …)` and
  `canonicalizeDeclaredConstraintBody` (which already has `schemaName` in scope at
  `:1588`) — pass the declared table's schema. Confirm `AST.DeclaredTable` exposes
  the schema being diffed (the differ runs per schema; thread that name in rather
  than re-deriving from a possibly-unqualified table name).

`childSchemaName` is optional so non-FK callers (CHECK / UNIQUE) and any caller
without a child-schema context are unaffected — those constraints have no schema
channel.

## Edge cases & interactions

- **Unqualified same-schema FK** (`references t`, the common case): declared
  `schema undefined`, actual elided → both `undefined`. No change vs today —
  guard against regression across the existing differ tests.
- **Explicit own-schema qualifier** (`references main.t` on a child in `main`):
  declared `'main'` → elided to `undefined`; matches actual. The bug this ticket
  fixes — no churn.
- **Genuine cross-schema FK** (`references main.m` on a child in `s2`): both sides
  `'main'`; unchanged across diffs → no churn.
- **Parent-schema change is a real body change**: editing a declared FK from
  `references s2.m` to `references main.m` (different parent schema, same table
  name) must canonicalize differently on the two declaration versions → differ
  emits drop+recreate. Add an explicit test — this is the "must differ" half of
  the symmetry.
- **FK rename inversion** (`canonicalizeDeclaredConstraintBody`, `:1598`): the
  parent **table** name is inverse-renamed (`:1617`), but the parent **schema** is
  not a rename channel — leave `foreignKey.schema` untouched through the clone, and
  ensure the clone copies it (spread already does). A parent-table rename across
  schemas is out of scope (renames are within-schema).
- **Case-insensitivity**: schema names fold via `.toLowerCase()` like every other
  identifier — `references MAIN.m` and `references main.m` canonicalize equal.
- **Tags / name channels**: schema qualifier lives in the body, not the name or
  tags channel — a schema change must surface as a body change, not a rename.

## TODO

- Thread an optional `childSchemaName` through `constraintBodyToCanonicalString`
  and `canonicalForeignKeyClause`; apply the elide-when-equal-child rule.
- Pass `tableSchema.schemaName` from `constraintToCanonicalDDL` (actual side).
- Pass the declared table's schema from `collectDeclaredNamedConstraints` and
  `canonicalizeDeclaredConstraintBody` (declared side); confirm the schema is
  available on `AST.DeclaredTable` / in the differ's per-schema context.
- Tests (DIFF/APPLY SCHEMA):
  - Re-declaring an unchanged cross-schema FK (`references main.m` on `s2` child)
    produces **no** diff op.
  - An explicit own-schema qualifier (`references main.t` on a `main` child) is
    equivalent to the unqualified form — no diff op.
  - Changing the declared parent schema (`references s2.m` → `references main.m`)
    is detected as a body change (drop+recreate).
  - Regression: existing same-schema FK differ tests unchanged.
- `yarn lint` (quereus), `yarn test`, `yarn test:store` all green.
