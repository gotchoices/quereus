description: |
  Quereus's CREATE TABLE parser used to throw away the exact type word a user typed (e.g. "BIGINT",
  "TIMESTAMP") once it classified the column into an internal type bucket — so a bigint column and a
  plain integer column both looked like "INTEGER" to anything reading the schema afterward. This change
  keeps the original word on the schema as extra information, so an external tool (the lamina project)
  can tell them apart again.
files:
  - packages/quereus/src/schema/column.ts        # ColumnSchema.declaredType?: string (new field, sibling to tags)
  - packages/quereus/src/schema/table.ts         # columnDefToSchema (:268) — schema.declaredType = def.dataType
  - packages/quereus/src/schema/ddl-generator.ts # formatColumnDef (:455) — NOTE tripwire comment
  - packages/quereus/test/column-declared-type.spec.ts  # new spec, 3 cases
difficulty: easy
---

## What shipped

`ColumnSchema` (`schema/column.ts:64`) gained one optional field `declaredType?: string`, populated in
`columnDefToSchema` (`schema/table.ts:268`) from the raw `def.dataType` token — the exact string the
parser captured, before `inferType` flattens it onto a shared logical type. Informational only: not
hashed, not compared, read nowhere inside Quereus. Consumer is the external lamina host, which reads the
live `TableSchema.columns` to build storage codecs and needs the pre-flatten distinction (BIGINT vs plain
INTEGER, TIMESTAMP vs BLOB). A `NOTE:` tripwire was added in `ddl-generator.ts` flagging that the
canonical-DDL emitter deliberately still emits `logicalType.name`, not `declaredType`.

## Review findings

Adversarial pass over the implement diff (commit `439c4a59`). Change is small, additive, well-scoped.

**Verified — no defects found:**

- **Leak into hashing/equality/comparison.** Grepped every `declaredType` and `tags` site across `src/`.
  `tags` (the sibling informational field the design mirrors) is handled *explicitly* at every schema
  path — differ, manager mutations, catalog, ddl-generator, `schema()` builtins. `declaredType` appears
  in exactly two places: the interface declaration and the one assignment. No generic key-iteration hash
  or equality routine sweeps it in. Confirms the "not behavior-bearing" design constraint holds.
- **Field reaches the consumer.** `columnDefToSchema` output is the `ColumnSchema` the manager holds and
  lamina reads; spread-based rebuilds preserve it. The catalog descriptor (`catalog.ts:254`) is a
  *separate* introspection projection (shape `{type, notNull, ...}`, not `ColumnSchema`) and legitimately
  omits `declaredType` — it is not lamina's path. End-to-end proof: lamina's `monotonic-sql-create.test.ts`
  went 2-failing → 7/7 passing with no lamina change.
- **Ticket premise correction stands.** Independently confirmed against `types/registry.ts`: `TIMESTAMP`
  has no registry entry and no `"INT"` affinity match, so `inferType('TIMESTAMP')` → `BLOB_TYPE`, not
  `INTEGER_TYPE` as the original ticket claimed. Only `BIGINT`/`INT`/`SMALLINT`/`TINYINT`/`MEDIUMINT` map
  to the shared `INTEGER_TYPE`. The new spec asserts the *observed* behavior — correct.
- **Edge cases.** No-declared-type column leaves `declaredType` undefined (not synthesized) — covered by
  spec case 3 and by `def.dataType` being `?: string` in the AST (`ast.ts:618,626`).

**Minor — doc-only, not fixed (not worth churning archival handoff):**

- The implement handoff's "casing/whitespace verbatim" gap note slightly overstates whitespace fidelity.
  `parseDataTypeName` (`parser.ts:3402`) concatenates lexemes, so *internal* paren whitespace is
  normalized: `VARCHAR( 100 )` → `declaredType: 'VARCHAR(100)'`. Casing and parametrization *are*
  preserved. No code impact — `declaredType` is exactly the same string `inferType` already consumed, so
  it is internally consistent with `logicalType`.

**Tripwires:** none newly recorded. The one `NOTE:` in `ddl-generator.ts:455` (raw token not emitted in
canonical DDL; prefer `col.declaredType` there if byte-faithful regen is ever needed) was placed by the
implementer, is correctly sited, and remains valid.

**Multi-word declared types (noted, not a defect of this change):** `parseDataTypeName` captures only a
single leading identifier + optional parens, so `DOUBLE PRECISION` yields `declaredType: 'DOUBLE'`. This
is pre-existing parser behavior — `inferType` receives the same truncated token — and `declaredType`
faithfully mirrors it. Not introduced here; out of scope.

## Validation

- New spec `test/column-declared-type.spec.ts`: 3/3 passing (BIGINT→INTEGER, TIMESTAMP→BLOB, undefined).
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`): clean.
- Full `yarn test` (packages/quereus): **6472 passing, 0 failing, 9 pending** — re-run in review, matches
  implement. The 9 pending are pre-existing/unrelated; no new pendings introduced.
- `yarn test:store` (LevelDB variant) not run — change is additive-only to `ColumnSchema` and touches no
  store code path; risk negligible. Consistent with implement's documented deferral.
