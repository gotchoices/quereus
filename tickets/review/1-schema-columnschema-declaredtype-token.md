description: |
  Quereus's CREATE TABLE parser used to throw away the exact type word a user typed (e.g. "BIGINT",
  "TIMESTAMP") as soon as it classified the column into one of a handful of internal buckets — so a
  bigint column and a plain integer column both became indistinguishable "INTEGER" to anything reading
  the table's schema afterward. This change makes the schema also keep the original word around, purely
  as extra information, so an external tool (the lamina project) can tell them apart again.
files:
  - packages/quereus/src/schema/column.ts        # ColumnSchema.declaredType?: string (new field, sibling to tags)
  - packages/quereus/src/schema/table.ts         # columnDefToSchema (~:259) — schema.declaredType = def.dataType
  - packages/quereus/src/schema/ddl-generator.ts # formatColumnDef (~:453) — NOTE tripwire comment added
  - packages/quereus/test/column-declared-type.spec.ts  # new spec, 3 cases
difficulty: easy
---

## What changed

`ColumnSchema` (`schema/column.ts`) gained one new optional field:

```ts
declaredType?: string;
```

Sibling to the existing `tags` field in standing: optional, informational only, NOT included in any
hash/equality/comparison path, NOT read anywhere else inside Quereus. `columnDefToSchema`
(`schema/table.ts:~259`) now sets it to the raw `def.dataType` token verbatim — the exact string the
parser captured from the DDL, before `inferType` classifies it — alongside the existing
`logicalType: inferType(def.dataType)` line. `registry.ts` (the flattening logic) was **not** touched, per
the ticket's explicit constraint.

`ddl-generator.ts`'s `formatColumnDef` (the canonical-DDL emitter used for persistence round-trips) still
emits `col.logicalType.name`, not `col.declaredType` — that's intentional, since this generator's job is
byte-faithful DDL regen, and `logicalType.name` is what already round-trips correctly today. Added a
`NOTE:` comment there flagging that if a future refactor needs the raw token in that path, don't silently
drop it again.

## Why (consumer context)

The lamina project (sibling checkout `../lamina`, package `lamina-quereus`) reads Quereus's `TableSchema`
directly (not the CREATE TABLE AST) to build its own storage codecs. Its `resolveDataType` helper
(`quereus-ast-translators.ts:~804`) already had a `declaredType`-preferring code path committed, dead until
this field existed. Verified fix end-to-end: ran lamina's
`packages/lamina-quereus-test/src/monotonic-sql-create.test.ts` (`node scripts/run-vitest.mjs run
monotonic-sql-create` from the lamina repo root) — **7/7 passing**, up from 2 failing before this change
(BIGINT and TIMESTAMP monotonic-column CREATE cases). No lamina-side code change was needed; its vitest
config aliases `@quereus/quereus` straight to this repo's `packages/quereus/src` via a `portal:` dependency,
so it picks up source changes here without a rebuild.

## Correction to the original ticket's premise

The ticket description asserted TIMESTAMP "collapses likewise" onto the shared `INTEGER_TYPE`. Verified
against the actual registry (`types/registry.ts`): `TIMESTAMP` has **no** registry entry and does not
contain the substring `"INT"`, so `inferType('TIMESTAMP')` actually falls through the SQLite-affinity rules
all the way to `BLOB_TYPE`, not `INTEGER_TYPE` — only `BIGINT` (and `INT`/`SMALLINT`/`TINYINT`/`MEDIUMINT`)
map onto the shared `INTEGER_TYPE` object. This doesn't change the fix (the field is populated the same way
regardless of what `logicalType` ends up being) but the new test (`column-declared-type.spec.ts`) asserts
the behavior actually observed — `declaredType: 'TIMESTAMP'` alongside `logicalType.name: 'BLOB'` — rather
than the ticket's original (incorrect) expectation of `'INTEGER'`. Confirmed independently: lamina's own
`resolveDataType` comment already documents "BIGINT→INTEGER, TIMESTAMP→BLOB", matching what's verified here.

## Testing performed

- New suite `packages/quereus/test/column-declared-type.spec.ts` (3 cases, all passing):
  - `id BIGINT` → `declaredType === 'BIGINT'`, `logicalType.name === 'INTEGER'`
  - `created TIMESTAMP` → `declaredType === 'TIMESTAMP'`, `logicalType.name === 'BLOB'`
  - no declared type (`create table t (id)`) → `declaredType` is `undefined` (not synthesized)
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`): clean.
- Full `yarn test` (packages/quereus): **6472 passing, 0 failing, 9 pending** (pending count is
  pre-existing/unrelated — not investigated as part of this ticket, no new pendings introduced).
- Cross-repo validation: lamina's `monotonic-sql-create.test.ts`, 7/7 passing (was 2 failing before).

## Known gaps / things the reviewer should double check

- Did not run `yarn test:store` (LevelDB-backed variant) — this change is additive-only to `ColumnSchema`
  and touches no store-module code path, so risk is low, but it wasn't exercised.
- Did not run lamina's full test suite, only the specifically-named failing file
  (`monotonic-sql-create.test.ts`); did not check whether other lamina tests incidentally depend on the
  *previous* (undefined) `declaredType` behavior in a way this now changes. Given the field was previously
  always `undefined` and lamina's `resolveDataType` treats `undefined`/empty as "fall through to `dataType`
  then `logicalType.name`" (unchanged for any column where `declaredType` doesn't apply), this seems safe,
  but wasn't exhaustively checked across lamina's whole suite.
- `def.dataType` is used verbatim, including whatever casing/whitespace the user typed (e.g.
  `VARCHAR(100)` would carry through as `declaredType: 'VARCHAR(100)'`, parens and all) — this matches the
  ticket's "raw DDL token verbatim" requirement, but is worth reviewer awareness if a consumer expects a
  bare type name without parametrization.
