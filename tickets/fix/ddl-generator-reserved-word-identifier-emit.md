description: Canonical DDL generator (schema → DDL string) emits COLLATE names, USING module names, and vtab-arg keys BARE, so a reserved-word-named collation/module/arg-key produces DDL that fails to re-parse. Same bug class the AST stringifier round-trip ticket closed, but in a second, independent emitter with no round-trip coverage.
files: packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/parser/parser.ts, packages/quereus/test/emit-roundtrip-positions.spec.ts
----

## Background

`reserved-word-identifier-emit-roundtrip` (now in `complete/`) closed the
"reserved word used as an identifier" emit-and-re-parse gap for the **AST
stringifier** (`src/emit/ast-stringify.ts`) and added a deterministic,
position-by-position round-trip suite (`test/emit-roundtrip-positions.spec.ts`).

That review found the same bug class still lives in a **second, independent DDL
emitter**: `src/schema/ddl-generator.ts` (`generateTableDDL` /
`generateIndexDDL`). This emitter builds DDL directly from `TableSchema` /
`IndexSchema` (not from an AST), is used for **persistence** (its output is
re-parsed on reload), and is *not* exercised by the AST round-trip suites.

Names (table/column/index/schema) in this generator are safe — they route
through `quoteName`, which **unconditionally** double-quotes. But three
identifier positions are emitted **bare**:

- **COLLATE name** — `ddl-generator.ts:88`: `colStr += \` COLLATE ${col.collation}\``
  (in `generateIndexDDL`). A keyword-named collation (`IndexSchema.columns[].collation`)
  emits `COLLATE select`, which fails to re-parse.
- **USING module name** — `ddl-generator.ts:188` and `:199`
  (`formatUsingClause`): `\`USING ${moduleName}\``. A keyword-named module emits
  `USING select`. (The AST stringifier's equivalent sites were just fixed to use
  `quoteIdentifier`; this generator was not.)
- **vtab-arg keys** — `ddl-generator.ts:206` (`formatVtabArgs`):
  `\`${key} = ...\``. The AST stringifier quotes these keys via `quoteIdentifier`
  (`ast-stringify.ts` ~1250); here they are bare, so a keyword-named arg key
  breaks round-trip.
- **assertion name** — `catalog.ts:265` (`assertionSchemaToCatalog`):
  `\`CREATE ASSERTION ${assertionSchema.name} CHECK (...)\``. Bare name; a
  keyword-named assertion breaks round-trip. (The AST stringifier's
  `createAssertionToString` already quotes via `quoteIdentifier`.) `catalog.ts`
  otherwise delegates table/index DDL to `generateTableDDL`/`generateIndexDDL`,
  so this assertion site is its only independent identifier emit.

### Also fix the stale sync banner

`parser.ts:39-44` lists the emitters that must stay in sync with parsed syntax.
Two entries are wrong: it names `packages/quereus-store/src/common/ddl-generator.ts`
(does not exist) and omits the real `packages/quereus/src/schema/ddl-generator.ts`.
Update the banner to list the actual emitters (`ast-stringify.ts`, `catalog.ts`,
`schema/ddl-generator.ts`) so the next person auditing this class finds them all.

## Severity / reachability

Real correctness bug (broken persisted DDL that won't reload), but only with
**exotic naming** — a collation, vtab module, or vtab-arg key whose name is a
reserved word. No such names exist in the current codebase, which is why it has
gone unnoticed. Still worth closing for the same reason the AST-side gap was:
silent, latent, and a single registration away from biting.

## Requirements

- Route the three bare positions through a quoting gate so reserved-word names
  survive a DDL → parse round-trip. Two valid styles already coexist in this
  file: `quoteName` (unconditional quotes, used for names) and the AST emitter's
  conditional `quoteIdentifier` (quote-only-when-necessary). Pick one and be
  consistent with the file's intent — `quoteName` is the simpler match for a
  persistence-safety-first generator, but verify it does not regress readability
  expectations encoded in existing `ddl-generator` tests (e.g.
  `packages/quereus-store/test/ddl-generator.spec.ts`, and any
  `generateTableDDL`/`generateIndexDDL` assertions in `packages/quereus`).
- The COLLATE-name fix should keep parity with the AST emitter's collation
  behavior (`ast-stringify.ts` `collate` cases now use `quoteIdentifier`).

## Test coverage (the floor — extend it)

The AST suite goes `parse → astToString → parse`; it can never reach this
generator. Add a **schema → DDL → parse** round-trip that drives reserved words
through `generateTableDDL` / `generateIndexDDL` for the three positions above
(programmatically build a `TableSchema`/`IndexSchema` with a keyword-named
collation / module / vtab-arg key, generate DDL, parse it, assert it parses and
the relevant value survives). Mirror the spirit of
`test/emit-roundtrip-positions.spec.ts` (drive the keyword set off
`Object.keys(KEYWORDS)` so it cannot drift from the lexer).

## Validation

```
yarn workspace @quereus/quereus run build
yarn workspace @quereus/quereus run lint
yarn workspace @quereus/quereus run test
```

Note: this generator feeds the store persistence path, so a follow-up
`yarn test:store` sanity check is worthwhile (out-of-band; not agent-runnable in
the ~10-min idle budget if it runs long).
