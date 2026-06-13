description: Parse, build, enforce, and persist schema-qualified foreign-key parent references (child schema ≠ parent schema).
prereq:
files:
  - packages/quereus/src/parser/parser.ts                       # foreignKeyClause() — add optional schema. qualifier
  - packages/quereus/src/parser/ast.ts                          # ForeignKeyClause — add schema?: string
  - packages/quereus/src/schema/constraint-builder.ts           # :96, :185 — referencedSchema = fk.schema ?? default
  - packages/quereus/src/schema/manager.ts                      # :1682 — column-level FK referencedSchema = fk.schema ?? schemaName
  - packages/quereus/src/planner/building/foreign-key-builder.ts # :146 synthesizeExistsCheck / :169 synthesizeNotExistsCheck — pass fromSchema
  - packages/quereus/src/schema/ddl-generator.ts                # :338 schemaConstraintToTableConstraint — emit schema (cross-schema only)
  - packages/quereus/src/emit/ast-stringify.ts                  # foreignKeyClauseTail (:1714), canonicalForeignKeyClause (:1616)
  - packages/quereus/test/logic/                                # new .sqllogic coverage
difficulty: medium
----

# Cross-schema FK: parse, build, enforce, persist

Make a foreign key able to reference a parent table in a **different schema** than
the child, end to end: syntax → schema object → enforcement (RESTRICT / CASCADE /
SET NULL / SET DEFAULT) → DDL persistence round-trip. The declarative-differ
canonical-comparison symmetry is split into the follow-on ticket
`cross-schema-fk-declarative-diff`.

## Background

Today a FK's parent is always keyed under the **child's** schema:

- The parser's `foreignKeyClause()` (`parser.ts:4529`) consumes a single bare
  identifier for the parent table — no `schema.table` qualifier is expressible.
- The schema builders hardcode `referencedSchema` to the child schema
  (`constraint-builder.ts:96` table-level, `:185` ADD COLUMN; `manager.ts:1682`
  column-level CREATE TABLE).
- ~12 downstream resolution sites already read `fk.referencedSchema ?? childSchema`
  (`manager.ts:1291` reverse-FK index, `multi-source.ts:2772` parent-side match,
  `derived-row-validator.ts:265/301`, `catalog.ts:250`, `ind-utils.ts:161`,
  `alter-table.ts:1519/1660`, `lens-*`), so they need **no change** once the field
  is populated from the qualifier.

Two enforcement sites, however, synthesize SQL that references the *other* table
**unqualified**, relying on same-schema name resolution — these break for a
cross-schema parent and must thread the resolved schema:

- **Child-side** (`foreign-key-builder.ts:228`): `synthesizeExistsCheck` →
  `synthesizeFKExistsExpr(parentTable.name, …)` with no `fromSchema`. The
  synthesized `exists (select 1 from <parent> where …)` resolves `<parent>` via
  the search path — for a cross-schema parent it finds the wrong table or none.
- **Parent-side RESTRICT** (`foreign-key-builder.ts:358`): `synthesizeNotExistsCheck`
  → `synthesizeFKNotExistsExpr(childTable.name, …)` with no `fromSchema` (see the
  comment at `:177`). Same problem in reverse for a cross-schema child.

Both `synthesizeFKExistsExpr` (`:69`) and `synthesizeFKNotExistsExpr` (`:116`)
**already accept** an optional `fromSchema` 5th arg (the lens path passes it —
`lens-enforcement.ts:487`); the physical path just never threads it.

The CASCADE / SET NULL / SET DEFAULT parent-side path through `multi-source.ts`
is already schema-aware — its table-reference helper (`multi-source.ts:2727`)
emits `{ schema: table.schemaName }` and the FK-targets-side predicate (`:2772`)
already keys on `fk.referencedSchema ?? child.schema.schemaName`. So those actions
work once `referencedSchema` is set correctly; verify, don't rebuild.

## Design

### AST + parser

Add `schema?: string` to `ForeignKeyClause` (`ast.ts:633`). In
`foreignKeyClause()` (`parser.ts:4529`), parse an optional `schema.` qualifier
before the parent table name, mirroring `tableIdentifier()` (`parser.ts:924`):

```
// after the optional REFERENCES is consumed:
let schema: string | undefined;
let table: string;
if (this.checkIdentifierLike(kw) && this.checkNext(1, TokenType.DOT)) {
  schema = this.consumeIdentifier(kw, "Expected schema name.");
  this.advance(); // DOT
  table = this.consumeIdentifier(kw, "Expected foreign table name after schema.");
} else {
  table = this.consumeIdentifier("Expected foreign table name.");
}
…
return { table, schema, columns, onDelete, onUpdate, deferrable, initiallyDeferred };
```

Use the same contextual-keyword set `tableIdentifier()` uses
(`[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']`) so a schema named `temp` parses.

### Schema builders — populate referencedSchema from the qualifier

Each of the three FK-build sites changes `referencedSchema: <default>` to
`referencedSchema: fk.schema ?? <default>`, preserving today's default when
unqualified:

- `constraint-builder.ts:96` (table-level) — `fk.schema ?? childSchemaName`
- `constraint-builder.ts:185` (`extractColumnLevelForeignKeys`) — `fk.schema ?? defaultSchemaName`
- `manager.ts:1682` (column-level in `extractForeignKeys`) — `fk.schema ?? schemaName`

`referencedSchema` therefore stays **always populated** (never undefined), so
`foreign-key-builder.ts:203`'s `findTable(fk.referencedTable, fk.referencedSchema)`
and every `?? childSchema` site keep working unchanged.

### Enforcement — thread the resolved schema into synthesized SQL

- Child-side: `synthesizeExistsCheck` (`foreign-key-builder.ts:146`) passes
  `parentTable.schemaName` as `fromSchema` to `synthesizeFKExistsExpr`.
- Parent-side RESTRICT: `synthesizeNotExistsCheck` (`:169`) passes
  `childTable.schemaName` as `fromSchema` to `synthesizeFKNotExistsExpr`, and the
  `:177` "no `fromSchema`" comment is updated.

Passing the table's own schema is a no-op for the same-schema case (the from-clause
already resolves to that schema) and correct for the cross-schema case — so this
is safe for existing FK tests.

### Persistence DDL round-trip

A store-backed catalog regenerates CREATE TABLE DDL and re-parses it, so a
cross-schema FK that isn't qualified in regenerated DDL silently loses its parent
schema on reload. Fix the round-trip:

- `schemaConstraintToTableConstraint` (`ddl-generator.ts:338`): set
  `foreignKey.schema` on the produced clause **only when it differs from the
  child** — `c.referencedSchema && c.referencedSchema.toLowerCase() !==
  tableSchema.schemaName.toLowerCase() ? c.referencedSchema : undefined`. This
  keeps same-schema FK DDL byte-identical to today (no qualifier), so existing DDL
  string assertions don't churn, while cross-schema FKs round-trip. Replace the
  stale "cannot encode `c.referencedSchema`" comment (`:345`).
- `foreignKeyClauseTail` (`ast-stringify.ts:1714`): render the qualifier when
  present — `references ${fk.schema ? quoteIdentifier(fk.schema) + '.' : ''}${quoteIdentifier(fk.table)}`.
- `canonicalForeignKeyClause` (`ast-stringify.ts:1616`): carry the schema through
  (lowercased) — `schema: fk.schema ? fk.schema.toLowerCase() : undefined` — so the
  canonical-body key reflects the parent schema. NOTE: full declared-vs-actual
  symmetry (eliding an explicitly-written `references <childschema>.t`) is the
  follow-on ticket's job; here just preserve the field so cross-schema and
  same-schema FKs to a like-named parent don't collapse to one key.

`func/builtins/schema.ts:351` already surfaces `fk.referencedSchema ?? null` in FK
introspection — it now reports the true parent schema with no change.

## Edge cases & interactions

- **Self-referencing FK** with explicit own-schema qualifier (`references s2.t`
  from `s2.t`): `validateForeignKeyCollations` (`constraint-builder.ts:479`)
  already computes `selfRef` from `fk.referencedSchema ?? childSchema` — confirm an
  explicitly-qualified self-FK still resolves against `childSchema` and validates
  at CREATE (table not yet registered).
- **Forward-declared cross-schema parent** (parent created after child): child-side
  builder must still emit the null-guards-only fallback (`foreign-key-builder.ts:209`)
  — `findTable(table, referencedSchema)` returns undefined, exactly as today.
- **`pragma foreign_keys = off`**: existing-row validators short-circuit; the
  cross-schema field must not change that gate.
- **MATCH SIMPLE NULL handling**: a child row with any NULL FK column passes
  regardless of the cross-schema parent — unchanged; verify the null-guard chain
  still wraps the now-qualified EXISTS.
- **Unqualified parent (the default)**: every existing same-schema FK must behave
  and persist **byte-identically** — `fk.schema` undefined → `referencedSchema`
  falls back to child schema → DDL emits no qualifier. This is the regression
  surface; the bulk of existing FK tests guard it.
- **Schema named with a reserved/contextual word** (`temp`): the parser must quote
  it on the qualifier and `foreignKeyClauseTail` must `quoteIdentifier` it.
- **Cross-schema parent dropped while child exists**: drop-ordering already
  excludes cross-schema FKs (`catalog.ts:251`) — dropping the parent schema/table
  is not blocked by the child's cross-schema FK; subsequent child DML then hits the
  parent-absent enforcement path. Confirm this is the intended (documented)
  behavior, not a regression.
- **Maintained table as cross-schema parent**: a maintained table in `main`
  referenced by a child in `s2` — parent-side referential actions must fire
  through the reverse-FK index (`manager.ts:1291`) now keyed under `main`.
- **Store vs memory**: run both `yarn test` and `yarn test:store` — the DDL
  round-trip only exercises under the store path.

## TODO

- Add `schema?: string` to `ForeignKeyClause` in `ast.ts`.
- Parse the optional `schema.` qualifier in `foreignKeyClause()` (both
  column-level and table-level FKs route through it).
- Populate `referencedSchema` from `fk.schema ?? <default>` at the three builder
  sites (`constraint-builder.ts:96`, `:185`, `manager.ts:1682`).
- Thread `fromSchema` through `synthesizeExistsCheck` (parent schema) and
  `synthesizeNotExistsCheck` (child schema); update the `:177` comment.
- DDL round-trip: emit the qualifier (cross-schema only) in
  `schemaConstraintToTableConstraint`; render it in `foreignKeyClauseTail`;
  preserve it in `canonicalForeignKeyClause`; replace the stale
  `ddl-generator.ts:345` comment.
- Tests (new `.sqllogic` under `test/logic/`):
  - CREATE child in `s2` with `references main.m(id)`; insert a child row whose
    parent exists → ok; insert an orphan → `FOREIGN KEY constraint failed`.
  - RESTRICT: delete a referenced `main.m` row while a `s2` child references it →
    blocked; delete an unreferenced parent row → ok.
  - CASCADE: `on delete cascade` from `s2` child to `main` parent — deleting the
    parent row removes the child row.
  - SET NULL / SET DEFAULT: deleting the cross-schema parent clears the child FK
    columns.
  - Maintained-table-in-`main` parent with child in `s2`: parent-side enforcement
    fires (the scenario `maintained-parent-fk-residual-arm-coverage` could not
    express).
  - Round-trip: a cross-schema FK survives DDL regeneration (assert under
    `test:store`, or via a DDL-introspection check that the qualifier is present).
  - Regression: an ordinary same-schema FK still emits unqualified DDL.
- `yarn lint` (quereus), `yarn test`, `yarn test:store` all green.
