description: Review the per-DB `default_collation` session option (`pragma default_collation = '<name>'` / `db.setOption`). It sets the declared collation that a column with NO explicit `COLLATE` resolves to at CREATE time. Defaults to `BINARY` (no behavior change). Text types resolve to the default; non-text (INTEGER/REAL/BLOB) and empty-collation types (JSON/temporal) fall back to BINARY. Explicit `COLLATE` always wins. The catalog stores concrete collations and persisted DDL always emits explicit non-BINARY `COLLATE`, so rehydrate (`importTable`) resolves omitted-COLLATE to fixed BINARY. The declarative differ resolves the declared side via the SAME create-time rule (threading the live option) for create/apply parity + idempotency.
files: packages/quereus/src/schema/table.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/index.ts, packages/quereus/test/logic/43.1-default-collation.sqllogic, packages/quereus/test/schema/catalog.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/core-api-features.spec.ts, docs/sql.md, docs/schema.md
----

## What shipped

A per-DB `default_collation` option that sets the collation an omitted-`COLLATE` column
resolves to at CREATE time. `BINARY` default ⇒ zero out-of-box behavior change. The catalog
always stores the concrete resolved collation; persisted DDL always carries an explicit
non-`BINARY` `COLLATE`, so the create-time convenience never leaks into persistence semantics.

### The single resolution helper (DRY — load-bearing)

`resolveDefaultCollation(logicalType, defaultCollation)` in `schema/table.ts` (exported from
`index.ts`). Returns `BINARY` for a `BINARY` default; otherwise the normalized default **only if**
`logicalType.supportedCollations?.includes(it)`, else `BINARY`. The explicit `?.includes()` gate
(NOT `validateCollationForType`'s throw) is deliberate: INTEGER/REAL/BLOB have
`supportedCollations === undefined` and would be *accepted* by `validateCollationForType` for any
collation, silently giving an INTEGER a NOCASE collation. Gating on explicit support falls those
types (and JSON/temporal's `[]`) back to BINARY. **The same helper drives CREATE and the differ**,
so the two cannot drift — this parity is what keeps `apply schema` idempotent.

### Wiring

- **Option** (`core/database.ts`): `default_collation`, default `'BINARY'`, `onChange` validates
  via `_getCollation(normalizeCollationName(value))` and throws (⇒ framework rollback) on unknown.
- **CREATE path**: `columnDefToSchema(def, defaultNotNull, defaultCollation='BINARY')` uses the
  helper for the no-explicit-COLLATE branch. Threaded: `buildColumnSchemas` →
  `buildTableSchemaFromAST`; `createTable` and `buildLogicalTableSchema` pass the **session**
  option; `importTable` passes `'BINARY'` (rehydrate stays canonical).
- **Differ** (`schema-differ.ts`): `defaultCollation` threaded through `computeSchemaDiff`
  (trailing, default `'BINARY'`) → `computeTableAlterDiff` → `computeColumnAttributeChange` →
  `extractDeclaredCollation` (resolves omitted COLLATE via the helper using `inferType(col.dataType)`).
  **Also threaded through the index path** (`declaredIndexCanonicalBody` → `declaredColumnCollation`)
  so an inherited-collation index column doesn't churn under a non-BINARY default. Both emitters in
  `runtime/emit/schema-declarative.ts` pass the live `default_collation`.
- **Persistence**: `ddl-generator.ts` unchanged — it already elides only a *literal* `BINARY`, so a
  resolved `NOCASE` always emits `COLLATE NOCASE`. Verified by test, not by editing the generator.

### Deliberate deviation from the plan prose (verify this reasoning holds)

The plan text said the differ's declared-side resolution should stay fixed-`BINARY`. The
implementation instead resolves the differ's declared side via the live default — see the long
"RESOLVED DEVIATION FROM PLAN" note in the source ticket. Rationale: a fresh `apply` emits the
declared DDL through `createTable` (→ session default ⇒ NOCASE in catalog); if the *next* diff
resolved the declared side to BINARY it would emit a spurious `SET COLLATE BINARY` every re-apply,
breaking parity AND idempotency. Fixed-BINARY is preserved only where it belongs: the
`importTable` rehydrate path (cross-session reopen), which relies on `generateTableDDL` emitting
explicit non-BINARY COLLATE.

## Use cases / behaviors to validate

- `pragma default_collation='nocase'; create table t (id integer primary key, name text)` ⇒
  `table_info('t')` shows `name` NOCASE, `id` BINARY; `where name = 'A'` matches a row inserted `'a'`.
- Default (BINARY): `where name = 'A'` does NOT match `'a'`; `table_info` shows BINARY.
- Non-text fallback: REAL/BLOB columns stay BINARY under NOCASE; JSON/temporal (`json`, `date`)
  stay BINARY.
- Explicit `COLLATE binary` under NOCASE default stays BINARY (case-sensitive) and sets
  `collationExplicit`; explicit `COLLATE rtrim` stays RTRIM.
- Catalog round-trip: under NOCASE, the persisted DDL emits `COLLATE NOCASE`; dropping +
  re-exec'ing it under a RESET-to-BINARY session still yields a NOCASE column (explicit COLLATE in
  persisted DDL wins).
- Declarative parity: direct `create table t (name text)` and `declare schema … apply` under NOCASE
  produce the same `ColumnSchema.collation` (NOCASE); a second `computeSchemaDiff(…, 'NOCASE')`
  yields `tablesToAlter: []`.
- API: `default_collation` get/set; an unknown value throws and rolls back to the prior value.

## Tests added

- `test/logic/43.1-default-collation.sqllogic` — behavior (table_info, `=` semantics, non-text +
  JSON/date fallback, explicit-COLLATE-wins, reset).
- `test/schema/catalog.spec.ts` — "emits explicit COLLATE under default_collation and survives a
  reset roundtrip".
- `test/declarative-equivalence.spec.ts` — new `describe('declarative-equivalence:
  default_collation')`: direct-vs-apply parity + idempotent re-diff (guards the differ change).
- `test/core-api-features.spec.ts` — default/get/set + invalid-value rejection & rollback.

## Validation performed (a floor, not a ceiling)

All green at handoff:
- `yarn workspace @quereus/quereus run build` → clean (EXIT 0).
- `yarn workspace @quereus/quereus run lint` → clean (EXIT 0).
- Targeted run of the 4 test groups above → 7 passing.
- `yarn workspace @quereus/quereus test` (full memory suite) → **5402 passing, 9 pending**, no regressions.

## Known gaps / reviewer attention

- **`yarn test:store` (store mode) NOT run.** ALTER ADD/RENAME COLUMN store paths are explicitly
  out of scope (they keep the `'BINARY'` default param). The store *rehydrate* path (`importTable`
  → `'BINARY'`) is exercised in memory mode but not re-verified under the LevelDB backend. A
  reviewer preparing a release may want `yarn test:store`.
- **Out of scope (documented, not done):** ALTER `ADD COLUMN`/`RENAME COLUMN` honoring
  `default_collation` (memory + store + isolation `deriveAddColumnBackfill`). Pre-existing backlog
  ticket `alter-add-column-default-collation` (prereq `default-collation-pragma`) tracks the
  CREATE-vs-ADD-COLUMN inconsistency footgun. The store physical-key collation default and
  explicit-COLLATE-on-non-text acceptance are owned by other tickets and untouched here.
- **Invalid-pragma error message is generic.** Via the pragma path, `pragma default_collation =
  'bogus'` surfaces as `Unknown pragma: default_collation` (pre-existing `runtime/emit/pragma.ts`
  wraps any `setOption` failure; the real `Unknown collation …` is chained as `cause`). The precise
  message + rollback is asserted at the `db.setOption` API level (core-api-features.spec.ts), not in
  sqllogic — mirroring how `default_column_nullability` does it. Worth confirming this is acceptable
  rather than improving `pragma.ts` to preserve the cause message (would be a separate, broader change).
- **Differ index-path threading** went slightly beyond the plan's explicit TODO (which named only
  the column-attribute path) to keep an inherited-collation index column from churning under a
  non-BINARY default. No dedicated index-idempotency test was added — the existing index-diff suite
  passes under the BINARY default; a reviewer wanting belt-and-suspenders could add a NOCASE-default
  inherited-index idempotency case.
