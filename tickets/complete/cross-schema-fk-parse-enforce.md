description: Cross-schema foreign-key support (parse → build → enforce → persist). A FK can reference a parent in a different schema than the child, end to end. Reviewed and accepted; declarative-differ symmetry deferred to the follow-on `cross-schema-fk-declarative-diff`.
prereq:
files:
  - packages/quereus/src/parser/ast.ts                            # ForeignKeyClause.schema?: string
  - packages/quereus/src/parser/parser.ts                         # foreignKeyClause() — optional schema. qualifier
  - packages/quereus/src/schema/constraint-builder.ts             # referencedSchema = fk.schema ?? default (2 sites)
  - packages/quereus/src/schema/manager.ts                        # extractForeignKeys column-level referencedSchema
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # synthesizeExistsCheck/synthesizeNotExistsCheck thread schema
  - packages/quereus/src/schema/ddl-generator.ts                  # schemaConstraintToTableConstraint emits qualifier (cross-schema only)
  - packages/quereus/src/emit/ast-stringify.ts                    # foreignKeyClauseTail renders qualifier; canonicalForeignKeyClause carries schema
  - packages/quereus/test/logic/41.5-cross-schema-foreign-keys.sqllogic   # enforcement coverage (memory + store)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts        # DDL round-trip unit tests
  - packages/quereus/test/emit/ast-stringify.spec.ts                       # parse→stringify→parse qualifier tests
  - docs/sql.md, docs/schema.md                                   # FK syntax + reverse-FK-index doc updates
----

# Cross-schema FK — parse, build, enforce, persist (complete)

A foreign key can reference a parent table in a **different schema** than the
child, end to end: parse → schema build → enforcement → DDL persistence. Same-schema
FK behaviour and DDL are byte-identical to before. The declarative-differ canonical
symmetry was deliberately scoped out and lives in the follow-on
`cross-schema-fk-declarative-diff` (in `implement/`, `prereq: cross-schema-fk-parse-enforce`).

## What landed

- **AST + parser.** `ForeignKeyClause` gained `schema?: string`. `foreignKeyClause()`
  parses an optional `schema.` qualifier before the parent table, mirroring
  `tableIdentifier()` (`[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']`). Both the inline
  `create table` path and the declarative `declare schema { table {…} }` body route
  through `foreignKeyClause()`.
- **Builders populate `referencedSchema`** from `fk.schema ?? <default>` at the three
  literal-assignment sites (`constraint-builder.ts` table-level + ADD COLUMN;
  `manager.ts` column-level; table-level CREATE delegates to the shared builder).
  `referencedSchema` stays always-populated, so the downstream `?? childSchema`
  resolution sites needed no change.
- **Enforcement threads the resolved schema** into synthesized SQL:
  `synthesizeExistsCheck` passes `parentTable.schemaName` (child-side EXISTS);
  `synthesizeNotExistsCheck` passes `childTable.schemaName` (parent-side RESTRICT
  NOT EXISTS). No-ops for same-schema FKs.
- **DDL persistence round-trip.** `schemaConstraintToTableConstraint` sets
  `foreignKey.schema` only when the parent schema differs from the child's (so
  same-schema FK DDL stays byte-identical). `foreignKeyClauseTail` renders the
  qualifier; `canonicalForeignKeyClause` carries the lowercased schema.

## Review findings

Adversarial pass over commit `9ec71fd8`, read diff-first before the handoff.

**Reviewed — and the verdict:**

- **Parser (`foreignKeyClause`).** Faithfully mirrors `tableIdentifier()`'s
  schema-qualifier detection (`checkIdentifierLike(contextualKeywords) &&
  checkNext(1, DOT)`); the `consumeIdentifier(keywords, msg)` overload resolves as
  intended (verified the two-arg overload at parser.ts:4019-4029). A `.` after the
  first identifier post-`references` is unambiguously a schema qualifier. **No issue.**
- **The flagged permissiveness change** (unqualified-parent branch now passes
  `contextualKeywords` to `consumeIdentifier`, so a contextual-keyword parent name
  parses bare). Confirmed intentional and *consistent* with `tableIdentifier()` —
  a hardening of parity, not a regression. **Accept; no action.**
- **Completeness of `referencedSchema` population.** Enumerated every literal
  `referencedSchema:` assignment via `find_references` — exactly three
  (`constraint-builder.ts` ×2, `manager.ts` ×1); the table-level CREATE path delegates
  to `buildForeignKeyConstraintSchema`, so it is covered. No other package builds FK
  schemas (store rehydrates via `generateTableDDL` → re-parse → manager). **Complete.**
- **Case handling (new risk).** `referencedSchema` now carries the *raw user-cased*
  qualifier (e.g. `references S2.par` → `'S2'`), whereas pre-change it was always a
  canonical registered name. Verified both resolution paths case-fold: `getSchema`
  (manager.ts:386) and `_findTable` (manager.ts:622-626) `.toLowerCase()` the schema;
  the reverse-FK index and the DDL cross-schema comparison both lowercase. Enforcement
  resolves `parentTable.schemaName` (canonical) into the synthesized SQL, so the raw
  casing never leaks downstream. **No bug.**
- **Catalog drop-ordering exclusion** (`catalog.ts:244-251`). The `fk.referencedSchema
  ?? tableSchema.schemaName` skip-cross-schema guard still holds correctly now that
  `referencedSchema` is always populated (the `??` branch is simply never taken).
  Documented behaviour unchanged. **Correct.**
- **`canonicalForeignKeyClause` carrying schema.** Confirmed this is a *fix* (a
  cross-schema FK and a same-schema FK to a like-named parent no longer collapse to one
  canonical key), introduces no new churn for existing same-schema scenarios (schema
  undefined on both sides), and the documented declared-vs-actual asymmetry for an
  explicit own-schema qualifier is genuinely captured by the follow-on ticket
  (read `cross-schema-fk-declarative-diff` — it covers exactly this, including the
  "must differ on a real parent-schema change" half). **Deferral legitimate.**
- **Docs.** Read both touched docs against the new reality: `docs/sql.md` FK syntax now
  shows `[schema.]foreign_table` for both column- and table-level forms with an accurate
  prose note; `docs/schema.md` reverse-FK-index description corrected from "keys under
  its child's schema" to "keys under its parent's schema (explicit qualifier or
  child-schema default)". **Accurate.**

**Tests (the implementer's are a floor — assessed for edge/error/regression/interaction):**
The new `41.5` covers both directions, all four reference actions on delete, a
maintained-table parent firing cross-schema RESTRICT through the reverse-FK index, a
self-referencing FK with explicit own-schema qualifier, cross-schema introspection, and
a same-schema introspection regression. The two unit specs cover deterministic DDL
emit/re-parse (cross-schema emits qualifier, same-schema omits) and parse→stringify→parse
for column/table-level forms plus a reserved-word (`"order"`) schema. Coverage is genuinely
strong across happy/edge/error/regression paths.

**Minor gaps noted (not blocking, no new ticket — low value):** `41.5` exercises ON
DELETE actions across schemas but not an explicit ON UPDATE CASCADE/SET-* across schemas,
and only single-column cross-schema FKs. The schema-threading logic is **action- and
arity-agnostic** (identical code path for delete/update; column count never enters the
schema resolution), and the same-schema suites already cover the action/multi-column
mechanics, so the residual risk is negligible. Recorded here rather than padded with
marginal tests.

**Findings disposition:**
- **Major (new ticket):** none.
- **Minor (fixed inline):** none required — no defects found.
- **Out of scope (correctly untouched):** declarative-differ symmetry
  (`cross-schema-fk-declarative-diff`); CASCADE/SET-* parent-side mechanics (already
  schema-aware via `multi-source.ts`); cross-schema parent drop-ordering (already
  excluded in `catalog.ts`).

## Validation (this review run)

- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — **clean** (exit 0).
- New `ddl-generator-roundtrip-positions.spec.ts` + `emit/ast-stringify.spec.ts` —
  **53 passing**.
- Full `yarn test` (memory) — **6127 passing**, 0 failing.
- Full `yarn test:store` (LevelDB) — **6123 passing**, 0 failing (exercises the actual
  persistence/rehydrate round-trip the ticket's "persist" claim rests on).

Accepted. Cross-schema FK parse/build/enforce/persist is correct and well-covered;
declarative-differ symmetry proceeds in the follow-on ticket.
