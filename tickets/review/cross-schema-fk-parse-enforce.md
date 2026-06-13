description: Review cross-schema foreign-key support (parse → build → enforce → persist). Verify the enforcement, DDL round-trip, and the deliberately-deferred declarative-differ symmetry.
prereq:
files:
  - packages/quereus/src/parser/ast.ts                            # ForeignKeyClause.schema?: string
  - packages/quereus/src/parser/parser.ts                         # foreignKeyClause() — optional schema. qualifier
  - packages/quereus/src/schema/constraint-builder.ts             # referencedSchema = fk.schema ?? default (2 sites)
  - packages/quereus/src/schema/manager.ts                        # extractForeignKeys column-level referencedSchema
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # synthesizeExistsCheck/synthesizeNotExistsCheck thread fromSchema
  - packages/quereus/src/schema/ddl-generator.ts                  # schemaConstraintToTableConstraint emits qualifier (cross-schema only)
  - packages/quereus/src/emit/ast-stringify.ts                    # foreignKeyClauseTail renders qualifier; canonicalForeignKeyClause carries schema
  - packages/quereus/test/logic/41.5-cross-schema-foreign-keys.sqllogic   # NEW enforcement coverage (memory + store)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts        # NEW DDL round-trip unit tests
  - packages/quereus/test/emit/ast-stringify.spec.ts                       # NEW parse→stringify→parse qualifier tests
  - docs/sql.md, docs/schema.md                                   # FK syntax + reverse-FK-index doc updates
difficulty: medium
----

# Review: cross-schema FK — parse, build, enforce, persist

A foreign key can now reference a parent table in a **different schema** than the
child, end to end. The declarative-differ canonical-comparison symmetry was
explicitly out of scope and lives in the follow-on `cross-schema-fk-declarative-diff`
(in `implement/`).

## What landed

- **AST + parser.** `ForeignKeyClause` gained `schema?: string`. `foreignKeyClause()`
  parses an optional `schema.` qualifier before the parent table, mirroring
  `tableIdentifier()` (uses `[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']`, so a
  schema named `temp` parses; a reserved-word schema like `"order"` quotes/round-trips).
  Both the inline `create table` path and the declarative `declare schema { table {…} }`
  body route through `foreignKeyClause()`, so both forms accept the qualifier.
  - Minor behavior note for the reviewer: the unqualified-parent branch now passes
    `contextualKeywords` to `consumeIdentifier` (previously a bare message-only call),
    matching `tableIdentifier()`. This is intentionally slightly more permissive
    (a contextual-keyword parent name now parses); flag if undesired.
- **Builders populate `referencedSchema`** from `fk.schema ?? <default>` at the three
  FK-build sites (`constraint-builder.ts` table-level + ADD COLUMN; `manager.ts`
  column-level). `referencedSchema` stays **always populated**, so the ~12 downstream
  `?? childSchema` resolution sites (reverse-FK index, multi-source CASCADE path,
  catalog drop-ordering, collation validation, introspection) needed **no change** —
  verified by reading each, not assumed.
- **Enforcement threads the resolved schema** into the synthesized SQL:
  `synthesizeExistsCheck` passes `parentTable.schemaName` (child-side EXISTS resolves
  the cross-schema parent); `synthesizeNotExistsCheck` passes `childTable.schemaName`
  (parent-side RESTRICT NOT EXISTS resolves the cross-schema child). Both are no-ops
  for same-schema FKs (the from-clause already resolves to that schema).
- **DDL persistence round-trip.** `schemaConstraintToTableConstraint` sets
  `foreignKey.schema` **only when the parent schema differs from the child's** — so
  cross-schema FKs round-trip while same-schema FK DDL stays byte-identical (no
  qualifier). `foreignKeyClauseTail` renders the qualifier; `canonicalForeignKeyClause`
  carries the schema (lowercased).

## Validation performed (all green)

- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — clean.
- Full `yarn test` (memory): **6127 passing**, 9 pending. No regressions.
- Full `yarn test:store` (LevelDB): **6123 passing**, 13 pending. No regressions.
- New `41.5-cross-schema-foreign-keys.sqllogic` passes in **both** memory and store mode.

## Use cases / scenarios covered by the new tests

`41.5-cross-schema-foreign-keys.sqllogic` (the floor — exercises both directions):
- Child in `s2` → parent in `main`: child-side INSERT (valid ok, NULL FK passes MATCH
  SIMPLE, orphan rejected).
- Parent-side **RESTRICT**: delete/update a referenced `main` parent blocked by the
  `s2` child; unreferenced parent delete succeeds.
- **CASCADE / SET NULL / SET DEFAULT** on delete, parent in `main` → child in `s2`.
- **Maintained-table parent** in `main`, child in `s2`: a maintenance delete fires the
  cross-schema RESTRICT through the reverse-FK index (the scenario the same-schema
  `maintained-parent-fk-residual-arm-coverage` could not express). Error surfaces as
  `violates RESTRICT`, source write rolled back atomically.
- **Self-referencing FK with explicit own-schema qualifier** (`references s2.tree`
  from `s2.tree`): validates at CREATE, enforces orphans, cascades.
- **Introspection** (reverse direction, child in `main` → parent in `s2`):
  `foreign_key_info('mchild')` reports `referenced_schema = 's2'`. Same-schema
  regression: `foreign_key_info` reports the child's own schema (`'main'`), unchanged.

Unit tests:
- `ddl-generator-roundtrip-positions.spec.ts` — `generateTableDDL` emits `references
  s2.par` for a cross-schema FK and re-parses with `foreignKey.schema === 's2'`; a
  same-schema FK emits **no** qualifier (`references par2`, never `main.par2`).
- `ast-stringify.spec.ts` — parse → stringify → parse preserves the qualifier
  (column- and table-level), omits it when unqualified, and quotes/round-trips a
  reserved-word schema (`"order"`).

## Known gaps / where to scrutinize

- **Declarative-differ symmetry is deliberately deferred** to
  `cross-schema-fk-declarative-diff`. `canonicalForeignKeyClause` now carries the
  schema (a *fix*: a cross-schema FK and a same-schema FK to a like-named parent no
  longer collapse to one canonical key). But it does **not** elide an explicitly-written
  *own-schema* qualifier. Consequence: a same-schema FK authored as `references
  main.parent` (redundant own-schema qualifier) yields a declared canonical key with
  `schema='main'`, while the regenerated/persisted DDL omits the qualifier → re-parsed
  `schema=undefined` → the two sides differ → the differ would see a spurious drop+add.
  This asymmetry is exactly the follow-on ticket's job. It does **not** affect ordinary
  unqualified same-schema FKs (schema undefined on both sides → match — confirmed by the
  full declarative-differ suite passing) or genuine cross-schema FKs (qualifier emitted
  on both sides → match). Reviewer: confirm you agree this is acceptable to defer, and
  that no current test authors an explicit own-schema qualifier (none did before — the
  parser couldn't express it).
- **Full close/reopen/rehydrate round-trip** is not exercised by a `.sqllogic` test
  (the harness uses one db per file, no reopen). Coverage instead comes from (a) the
  store-mode run of `41.5` (store persists via `generateTableDDL` with the qualifier
  patch and reconstructs the connected-table schema) and (b) the deterministic
  `generateTableDDL` + re-parse unit test. If the reviewer wants a true reopen test,
  the store package's `rehydrate-catalog.spec.ts` is the natural home.
- **Test schema-registration idiom.** The new sqllogic registers the auxiliary schema
  with `declare schema s2 {}` + `apply schema s2` (empty declaration) and then creates
  child/parent tables imperatively with `create table s2.<name>`. Validated to work in
  both modes; flag if a different idiom is preferred.
- **`referenced_schema` is now always non-null** in `foreign_key_info` (it was already
  populated to the child schema for same-schema FKs pre-change, so no existing assertion
  churns — `06.3.2` selects `referenced_table`, not `referenced_schema`). Confirm no
  external consumer relied on a null `referenced_schema` for same-schema FKs.

## Out of scope (correctly untouched)

- Declarative-differ declared-vs-actual symmetry → `cross-schema-fk-declarative-diff`.
- CASCADE/SET-NULL/SET-DEFAULT parent-side mechanics (already schema-aware via
  `multi-source.ts` `fkTargetsSide`) — verified, not rebuilt.
- Cross-schema parent drop-ordering (already excluded in `catalog.ts`) — confirmed the
  documented behavior (dropping a cross-schema parent is not blocked by the child FK;
  subsequent child DML hits the parent-absent enforcement path).
