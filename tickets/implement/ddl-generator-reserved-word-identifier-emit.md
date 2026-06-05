description: Route the four bare identifier positions in the canonical DDL generator (COLLATE name, USING module name, vtab-arg keys, CREATE ASSERTION name) through `quoteIdentifier` so reserved-word names survive a schema → DDL → parse round-trip. Add a schema-driven round-trip suite and fix the stale emitter-sync banner in parser.ts.
files: packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/emit-roundtrip-positions.spec.ts, packages/quereus-store/test/ddl-generator.spec.ts
----

## Summary

`src/schema/ddl-generator.ts` and `src/schema/catalog.ts` form a second,
independent DDL emitter (separate from the AST stringifier `src/emit/ast-stringify.ts`).
It builds DDL directly from `TableSchema` / `IndexSchema` for **persistence** —
its output is re-parsed on reload. Table/column/index/schema names route through
`quoteName` (unconditional double-quote) and are safe. But four identifier
positions are emitted **bare**, so a reserved-word-named collation / module /
vtab-arg key / assertion produces DDL that fails to re-parse.

This is the same bug class `reserved-word-identifier-emit-roundtrip` (in
`complete/`) closed for the AST stringifier. The AST-side round-trip suites
(`test/emit-roundtrip-positions.spec.ts`, `emit-roundtrip-property.spec.ts`) go
`parse → astToString → parse` and **structurally cannot** reach this generator,
so the gap is uncovered.

## Confirmed bare-emit sites (line numbers as of this writing — may drift slightly)

- **COLLATE name** — `ddl-generator.ts:88` (`generateIndexDDL`):
  `if (col.collation) colStr += \` COLLATE ${col.collation}\`;`
- **USING module name** — `ddl-generator.ts:188` and `:200` (`formatUsingClause`):
  `let clause = \`USING ${moduleName}\`;` (two emit paths: the no-db branch and
  the db-context branch).
- **vtab-arg keys** — `ddl-generator.ts:206` (`formatVtabArgs`):
  `.map(([key, value]) => \`${key} = ${formatSqlLiteral(value)}\`)`.
- **assertion name** — `catalog.ts:305` (`assertionSchemaToCatalog`):
  `ddl: \`CREATE ASSERTION ${assertionSchema.name} CHECK (${assertionSchema.violationSql})\``.
  This is `catalog.ts`'s only independent identifier emit; it otherwise delegates
  table/index DDL to `generateTableDDL` / `generateIndexDDL`.

## Correction approach — use `quoteIdentifier`, NOT `quoteName`

The ticket left the quoting-style choice open (`quoteName` unconditional vs.
`quoteIdentifier` conditional). **The existing store test forces `quoteIdentifier`.**
`packages/quereus-store/test/ddl-generator.spec.ts` asserts these emit **bare**:

- `expect(ddl).to.include('COLLATE NOCASE')`        (line ~215)
- `expect(ddl).to.include('USING store')`           (lines ~107, ~186)
- `expect(ddl).to.include("collation = 'NOCASE'")`  (line ~188)
- `expect(ddl).to.include('cache_size = 100')`      (line ~189)

`quoteName` would turn these into `COLLATE "NOCASE"`, `USING "store"`,
`"collation" = ...` and regress all of them. `quoteIdentifier` quotes
**only** when the name is a keyword or not a bare-valid identifier
(`ast-stringify.ts:50-55`), so `NOCASE` / `store` / `collation` / `cache_size`
stay bare (they are not keywords) while `select` / `order` get quoted. This also
gives the COLLATE parity the ticket asks for: `ast-stringify.ts` `collate`
cases (lines ~90, ~291) already use `quoteIdentifier`.

`quoteIdentifier` is already imported in `ddl-generator.ts` (line 25). `catalog.ts`
imports from `ast-stringify.js` but not `quoteIdentifier` — add it to that import.

### Case-preservation nuance for COLLATE

The AST emitter lowercases: `quoteIdentifier(expr.collation.toLowerCase())`
(`ast-stringify.ts:291`). The generator currently preserves case and the store
test asserts **uppercase** `COLLATE NOCASE`. To avoid regressing that test,
**do not lowercase here** — emit `quoteIdentifier(col.collation)` (preserve
case). Collation names are case-insensitive in SQL, so this still round-trips;
matching the AST emitter's *gate* (quoteIdentifier) is the parity that matters,
not the casing. (If you prefer to lowercase for strict parity, you must also
update the store test's `COLLATE NOCASE` assertion — preferring the
no-test-churn path is recommended.)

## Stale sync banner (parser.ts:39-44)

The banner listing emitters that must stay in sync with parsed syntax is wrong:
it names `packages/quereus-store/src/common/ddl-generator.ts` (does not exist)
and omits the real `packages/quereus/src/schema/ddl-generator.ts`. Fix the list
to the three actual emitters:
- `packages/quereus/src/emit/ast-stringify.ts`
- `packages/quereus/src/schema/catalog.ts`
- `packages/quereus/src/schema/ddl-generator.ts`

## Test coverage (new schema → DDL → parse suite)

The floor: add a deterministic round-trip that drives reserved words through
`generateTableDDL` / `generateIndexDDL` (both exported from `@quereus/quereus`)
for the three generator positions. Mirror the spirit of
`test/emit-roundtrip-positions.spec.ts`: drive the keyword set off
`Object.keys(KEYWORDS)` (from `src/parser/lexer.js`) so it cannot drift from the
lexer. For each keyword `kw`:

- **COLLATE**: build an `IndexSchema` with `columns: [{ index, collation: kw }]`,
  generate via `generateIndexDDL`, `parse()` the result, assert it parses and the
  collation survives.
- **USING module**: build a `TableSchema` with `vtabModuleName: kw` (no db
  context → USING emitted unconditionally), `generateTableDDL`, `parse`, assert.
- **vtab-arg key**: build a `TableSchema` with `vtabModuleName: 'store'` and
  `vtabArgs: { [kw]: 'v' }`, `generateTableDDL`, `parse`, assert the arg key
  survives.

Reuse the `makeTableSchema` / `makeColumn` helper style from
`packages/quereus-store/test/ddl-generator.spec.ts` (it builds minimal schemas).
The new suite lives in `packages/quereus/test/` (engine package — `parse` and
`generateTableDDL`/`generateIndexDDL` are both reachable there via
`../src/parser/index.js` and `../src/schema/ddl-generator.js`).

Assertion name (`catalog.ts:305`) is emitted inside the private
`assertionSchemaToCatalog`. If a public driver (e.g. a `schemaToCatalog`-style
export or an end-to-end `CREATE ASSERTION "select" ... ; reload` path) is
reachable without contortion, add a round-trip for it too; otherwise a focused
assertion that the emitted `ddl` string for a keyword-named assertion re-parses
is acceptable. Note in the test what you covered and what you deferred — do not
silently skip the assertion site.

## Validation

```
yarn workspace @quereus/quereus run build
yarn workspace @quereus/quereus run lint
yarn workspace @quereus/quereus run test
```

The generator feeds the store persistence path. A follow-up `yarn test:store`
sanity check is worthwhile but is **out-of-band** (not agent-runnable in the
~10-min idle budget if it runs long) — note it in the review handoff rather than
blocking on it.

## TODO

- In `ddl-generator.ts:88`, wrap the COLLATE name: `\` COLLATE ${quoteIdentifier(col.collation)}\`` (preserve case — see nuance above).
- In `ddl-generator.ts` `formatUsingClause`, quote the module name in **both** emit paths (`:188` no-db branch and `:200` db-context branch): `USING ${quoteIdentifier(moduleName)}`.
- In `ddl-generator.ts:206` `formatVtabArgs`, quote the key: `\`${quoteIdentifier(key)} = ...\``.
- In `catalog.ts`, add `quoteIdentifier` to the `../emit/ast-stringify.js` import and quote the assertion name at `:305`: `CREATE ASSERTION ${quoteIdentifier(assertionSchema.name)} CHECK (...)`.
- Fix the emitter-sync banner in `parser.ts:39-44` to list the three real emitters.
- Add `packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts` (or similar) driving `Object.keys(KEYWORDS)` through the COLLATE / USING-module / vtab-arg positions via `generateIndexDDL` / `generateTableDDL` → `parse` → assert; cover the assertion site if a reasonable public driver exists.
- Confirm `packages/quereus-store/test/ddl-generator.spec.ts` still passes unchanged (the `quoteIdentifier` choice is specifically to avoid regressing its bare-emit assertions).
- Run build + lint + test (commands above); note the deferred `yarn test:store` in the review handoff.
