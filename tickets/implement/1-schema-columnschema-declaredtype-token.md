description: |
  ColumnSchema drops the raw declared type token from a CREATE TABLE column def. inferType flattens
  BIGINT/TIMESTAMP to the shared INTEGER_TYPE (name 'INTEGER') before any consumer sees the schema, so
  a downstream host (lamina) that needs to distinguish bigint/timestamp from plain integer cannot. Carry
  the raw def.dataType token forward on a new informational ColumnSchema.declaredType field.
files:
  - packages/quereus/src/schema/column.ts        # ColumnSchema — add declaredType?: string (sibling to tags)
  - packages/quereus/src/schema/table.ts         # columnDefToSchema (~:255) — set schema.declaredType = def.dataType alongside logicalType: inferType(def.dataType)
  - packages/quereus/src/schema/ddl-generator.ts # add NOTE tripwire so a future refactor does not silently drop the field
  - packages/quereus/src/types/registry.ts       # :47 this.types.set('BIGINT', INTEGER_TYPE) — where the token flattens (read-only context; do NOT change)
difficulty: easy
----

## Problem

`columnDefToSchema` (`schema/table.ts:~255`) calls `inferType(def.dataType)` and stores only the resulting
`logicalType`. The type registry (`types/registry.ts:47`) maps `BIGINT` → the *shared* `INTEGER_TYPE`
object whose `name` is `'INTEGER'`; `TIMESTAMP` collapses likewise. So after `inferType`, the
`BIGINT`/`TIMESTAMP` vs plain `INTEGER` distinction is erased — the only place the raw token `'BIGINT'`
still exists is `def.dataType` inside `columnDefToSchema`, and it is thrown away there.

`ColumnSchema` (`schema/column.ts:10`) has no field to carry the raw token forward (0 hits for
`declaredType`). A host module receiving the projected `TableSchema` (not the CREATE-TABLE AST) therefore
recovers only the flattened `'INTEGER'` and cannot tell a `bigint`/`timestamp` column from an `int`.

## Downstream consumer (why this matters)

The lamina host (sibling `../lamina` checkout, `packages/lamina-quereus`) already has its half committed:
`resolveDataType` (`quereus-ast-translators.ts:~804`) *prefers* `ColumnSchema.declaredType`, falling back
to `dataType` then `logicalType.name`. It is a no-op today only because Quereus never populates
`declaredType`. Two lamina e2e tests
(`packages/lamina-quereus-test/src/monotonic-sql-create.test.ts`, BIGINT + TIMESTAMP monotonic CREATE
cases) fail with "Column tagged 'monotonic = true' has type incompatible with the bigint codec" purely
because the token never crosses the Quereus→host seam. Populating `declaredType` here clears both with no
lamina change and no rebuild (lamina reads quereus `src/` via its vitest `portal:` alias).

## Expected behavior

`ColumnSchema` carries the raw declared type token as written in the DDL (`'BIGINT'`, `'TIMESTAMP'`, …),
independent of the flattened `logicalType`. It is **informational only** — a sibling to the existing `tags`
slot: not part of hashing, comparison, or any behavior inside Quereus. Nothing in Quereus reads it; the
consumer is the external host.

## Edge cases

- `def.dataType` absent / column with no declared type: leave `declaredType` `undefined` (optional field);
  do not synthesize a token.
- Do not derive `declaredType` from `logicalType` — that would defeat the purpose (it is already flattened).
  The value must be the raw DDL token verbatim.
- Confirm the field survives whatever schema projection path reaches `LaminaModule.create` — it must ride on
  the same `ColumnSchema` that `tags` does.

## Design constraints

- Mirror the existing `tags` slot's standing: optional, informational, not hashed, not behavior-bearing. Do
  NOT add it to any canonical-hash input or equality check.
- Do NOT touch the type registry flattening (`registry.ts:47`) — the shared `INTEGER_TYPE` mapping is correct
  and load-bearing elsewhere; the fix is to preserve the token *before* flattening, not to un-flatten.

## TODO

- Add `declaredType?: string;` to `ColumnSchema` (`schema/column.ts`), sibling to `tags`.
- In `columnDefToSchema` (`schema/table.ts`), set `schema.declaredType = def.dataType` alongside
  `logicalType: inferType(def.dataType)`.
- Add a `NOTE:` tripwire comment in `ddl-generator.ts` at the column-schema construction/round-trip site so a
  future refactor does not silently drop the field.
- Add a test asserting a `bigint` (and `timestamp`) column def yields `ColumnSchema.declaredType === 'BIGINT'`
  (resp. `'TIMESTAMP'`) while `logicalType.name` stays `'INTEGER'`.
