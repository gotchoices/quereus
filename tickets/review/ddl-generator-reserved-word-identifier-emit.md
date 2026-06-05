description: Review the canonical DDL generator reserved-word fix — four bare identifier positions (COLLATE name, USING module name, vtab-arg key, CREATE ASSERTION name) now route through `quoteIdentifier`, plus a schema→DDL→parse round-trip suite and a corrected emitter-sync banner.
files: packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/parser/parser.ts, packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts, packages/quereus-store/test/ddl-generator.spec.ts
----

## What this implements

`src/schema/ddl-generator.ts` + `src/schema/catalog.ts` are the persistence-oriented
DDL emitter (output is re-parsed on reload), separate from the AST stringifier.
Four identifier positions were emitted **bare**, so a reserved-word-named
collation / module / vtab-arg key / assertion produced DDL that fails to re-parse.
This is the same bug class `reserved-word-identifier-emit-roundtrip` (in `complete/`)
closed for the AST stringifier; the AST round-trip suites structurally cannot reach
this generator, so the gap was uncovered.

## Changes made (all five TODOs landed)

- **COLLATE name** — `ddl-generator.ts:88` → `` COLLATE ${quoteIdentifier(col.collation)} ``.
  Case is **preserved** (not lowercased) to match the store test's `COLLATE NOCASE`
  assertion; collation names are case-insensitive so this still round-trips, and the
  parity that matters (the `quoteIdentifier` *gate*) matches the AST emitter.
- **USING module name** — `ddl-generator.ts:188` **and** `:199`. **Both** emit paths in
  `formatUsingClause` were updated: the no-db branch *and* the db-context branch.
  ⚠️ Note for reviewer: the initial `replace_all` only caught line 188 (the two lines
  had different indentation — 2 tabs vs 1); line 199 was fixed in a follow-up edit.
  Both are now `USING ${quoteIdentifier(moduleName)}` and both are test-covered.
- **vtab-arg key** — `ddl-generator.ts:206` → `` ${quoteIdentifier(key)} = ... ``.
- **assertion name** — `catalog.ts:305` → `CREATE ASSERTION ${quoteIdentifier(name)} CHECK (...)`;
  `quoteIdentifier` added to the `../emit/ast-stringify.js` import.
- **emitter-sync banner** — `parser.ts:39-44` now lists the three real emitters
  (`ast-stringify.ts`, `schema/catalog.ts`, `schema/ddl-generator.ts`); the stale
  `quereus-store/src/common/ddl-generator.ts` (does not exist) was removed.

### Quoting-style choice — `quoteIdentifier`, NOT `quoteName`
`quoteIdentifier` quotes **only** keywords / non-bare-valid names (`ast-stringify.ts:50`),
so `NOCASE` / `store` / `collation` / `cache_size` stay bare while `select` / `order`
get quoted. `quoteName` (unconditional) would have regressed the store test's bare-emit
assertions (`COLLATE NOCASE`, `USING store`, `collation = 'NOCASE'`, `cache_size = 100`).
The store test `packages/quereus-store/test/ddl-generator.spec.ts` is the forcing
constraint here and still passes **unchanged** (16/16 verified).

## Tests added

`packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts` — a deterministic
schema → DDL → parse round-trip, driving the keyword set straight off
`Object.keys(KEYWORDS)` (lexer) so it can't drift, mirroring the spirit of
`emit-roundtrip-positions.spec.ts`. 9 tests, all passing:

- **COLLATE name** — `IndexSchema{collation: kw}` → `generateIndexDDL` → `parse`,
  asserts re-parse succeeds and the collation survives (the parser folds
  `c COLLATE x` into a `collate` expr on `columns[0].expr`, so the test reads it
  from there — see `collationOf` helper).
- **USING module — no-db branch** — `TableSchema{vtabModuleName: kw}` → `generateTableDDL()`
  (no db) → `parse`, asserts module name survives.
- **USING module — db-context branch** — `generateTableDDL(table, db)` with a fresh
  `Database` (whose `default_vtab_module` defaults to `'memory'`, ≠ every keyword),
  exercising the second emit path (line 199).
- **vtab-arg key** — `TableSchema{vtabModuleName:'store', vtabArgs:{[kw]:'v'}}` →
  `generateTableDDL` → `parse`, asserts the arg key survives in `moduleArgs`.
- **CREATE ASSERTION name** — driven through the public `collectSchemaCatalog(db)` over
  a real keyword-named assertion created via `db.exec('create assertion "select" check (1=1)')`;
  asserts the emitted catalog `ddl` quotes the name.
- **no-over-quoting** checks for COLLATE / USING / vtab-arg (ordinary names stay bare),
  pinning the "quote only when necessary" policy against an always-quote regression.

## Known gaps / things for the reviewer to probe (treat tests as a floor)

1. **Assertion `ddl` is NOT fully re-parseable — by design, pre-existing.**
   `assertionSchemaToCatalog` emits `CREATE ASSERTION <name> CHECK (<violationSql>)`,
   where `violationSql` is `select 1 where not (<expr>)` (a full SELECT, set in
   `runtime/emit/create-assertion.ts:24`). That is **not** a CHECK-*expression*, so the
   full assertion DDL never round-trips through `parse()` regardless of the name — the
   parser's `createAssertionStatement` calls `this.expression()` after `CHECK (`, which
   rejects a leading `select`. The test therefore asserts only the **name-quoting** (the
   property this ticket fixes), not a full re-parse. **Open question worth a look:** is
   the assertion catalog `ddl` ever re-parsed on reload / used for anything beyond
   hashing+display? If yes, the `violationSql`-in-CHECK-slot format is broken
   independently of reserved words and would warrant its own fix/backlog ticket. I did
   not change that format here (out of scope).

2. **vtab-arg key value-side coercion not asserted.** The test asserts the arg *key*
   survives; it does not pin the value round-trip (the parser coerces literal vs
   identifier values in `nameValueItem`). The store spec covers value formatting
   (`collation = 'NOCASE'`, `cache_size = 100`) so this is low-risk, but not belt-and-suspenders.

3. **`yarn test:store` deferred (out-of-band).** The generator feeds the store
   persistence path, but `test:store` runs the full logic suite against LevelDB and is
   not agent-runnable inside the ~10-min idle budget. **Recommend a reviewer/CI run of
   `yarn test:store`** as a persistence sanity check — nothing in the diff should affect
   it (the bare-emit assertions are preserved), but it exercises the real reload path
   that motivates this generator.

## Validation performed (all green)

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus run test` → **4809 passing**, 9 pending, exit 0
- new spec in isolation → 9 passing
- `packages/quereus-store/test/ddl-generator.spec.ts` → 16 passing (no regression)
- **Deferred:** `yarn test:store` (see gap 3).
