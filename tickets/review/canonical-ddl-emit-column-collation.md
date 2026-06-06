description: |
  Review the fix that makes canonical table DDL emit a column-level
  `COLLATE <name>` clause so a non-default column collation survives a re-parse
  of the canonical DDL (notably the @quereus/store persistence round-trip).
  Before this, `formatColumnDef` dropped COLLATE entirely and a `collate nocase`
  column silently reverted to BINARY on reopen.
files:
  - packages/quereus/src/schema/ddl-generator.ts                  # formatColumnDef: COLLATE emission added (mirrors generateIndexDDL)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # generator unit tests
  - packages/quereus-store/test/rehydrate-catalog.spec.ts         # collation-survives-reopen round-trip test
  - tickets/.pre-existing-error.md                                # flags an unrelated pre-existing optimizer-timeout failure
prereq:
----

# Review: emit column-level COLLATE in canonical table DDL

## What changed

`formatColumnDef` (`ddl-generator.ts`) now emits `COLLATE ${quoteIdentifier(col.collation)}`
when `col.collation && normalizeCollationName(col.collation) !== 'BINARY'`,
placed **after** the nullability annotation and **before** the inline
`PRIMARY KEY`. Added `import { normalizeCollationName } from '../util/comparison.js'`.

Design decisions, all as specified in the implement ticket:
- **Quoting:** conditional `quoteIdentifier` (operand identifier), matching the
  index column path — `COLLATE NOCASE` stays bare, `COLLATE "select"` quotes.
- **Default elision:** both `'BINARY'` and `''` emit no COLLATE; casing folded
  via `normalizeCollationName` (`'binary'` also elides).
- **No session-default config:** the no-db and db-context branches emit COLLATE
  identically (collation has no default-elision), preserving the byte-identical
  guarantee.

No parser/AST/schema change — `columnDefToSchema` already handles the `'collate'`
column constraint via `validateCollationForType` → `normalizeCollationName`.

## Validation performed

- `yarn workspace @quereus/quereus test` — **2305 passing, 1 failing**. The one
  failure is a **pre-existing, unrelated** 2000ms timeout in
  `optimizer/inclusion-dependencies.spec.ts` (verified identical on the stashed
  clean tree at HEAD). Documented in `tickets/.pre-existing-error.md`.
- New generator unit tests (all green, run via `--grep`):
  - Reserved-word COLLATE sweep over the whole `KEYWORDS` table
    (`generateTableDDL` → parse → column's `collate` constraint survives).
  - Bare-vs-quoted: `COLLATE NOCASE` bare; reserved-word `COLLATE "select"` quoted.
  - Default elision: `'BINARY'`, `''`, and `'binary'` each emit no COLLATE.
  - Round-trip: `generateTableDDL` of a `TEXT COLLATE NOCASE` column → parse →
    `columnDefToSchema` yields `collation === 'NOCASE'`.
- New store round-trip test `non-default column COLLATE survives reopen`
  (`rehydrate-catalog.spec.ts`): CREATE collated table under `USING store`,
  insert, `rehydrateCatalog` into a second db, assert rehydrated schema column
  `collation === 'NOCASE'`. **Negative-confirmed**: with the generator change
  reverted + rebuilt, this test fails with `-BINARY / +NOCASE`, proving it's a
  real guard, not a tautology.
- `yarn lint` (packages/quereus) — clean.
- Existing `declarative-equivalence: column collation drift` tests still pass,
  including *"absent COLLATE and an explicit COLLATE BINARY are equal — no
  spurious diff"* — confirms the new emission introduces **no** schema-differ
  churn (the differ compares parsed-declared vs actual-catalog collation, not
  the canonical DDL string).

## Review focus / known gaps (treat tests as a floor)

- **Placement choice** — COLLATE sits before inline `PRIMARY KEY`. Column
  constraints re-parse order-independently, so this is cosmetic, but a reviewer
  may want to eyeball the emitted string for a PK + collated column
  (`"name" TEXT COLLATE NOCASE PRIMARY KEY DEFAULT ...`) for readability.
- **Synthesized all-columns key** — `findPKDefinition` derives each synthesized
  key column's collation from `columns[i].collation`, so restoring column
  COLLATE on reopen also restores a no-PK table's synthesized-key comparison
  semantics. I did **not** add a dedicated behavioral test for this (the ticket
  rated it a sanity assert, not a separate test); the schema-introspection
  assert covers the column field it derives from. A reviewer wanting belt-and-
  suspenders could add a no-PK collated-table reopen assert.
- **Store-side UNIQUE enforcement under collation** — explicitly out of scope.
  The store round-trip test asserts the **rehydrated schema's** `collation`
  field (deterministic), not store-path case-insensitive UNIQUE rejection. The
  observable enforcement change (memory-vtab `checkUniqueByScanning` /
  `IsolatedTable.keysEqual` honoring the restored collation) is covered by
  existing engine behavior, not re-proven here.
- **`yarn test:store`** (the slower store-logic re-run) was **not** executed —
  the store DDL path is exercised by the new mocha test in the store package's
  own suite, which passed. A reviewer preparing a release may want to run it.
- **Pre-existing failure** — do not chase the optimizer IND timeout under this
  ticket; it predates the change (see `tickets/.pre-existing-error.md`).
