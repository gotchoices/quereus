description: Canonical DDL generator now routes four bare identifier positions (COLLATE name, USING module name, vtab-arg key, CREATE ASSERTION name) through `quoteIdentifier`, so reserved-word-named collations/modules/arg-keys/assertions re-parse on reload. Plus a schema→DDL→parse round-trip suite and a corrected emitter-sync banner.
files: packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/parser/parser.ts, packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts, packages/quereus-store/test/ddl-generator.spec.ts
----

## What shipped

The persistence-oriented DDL emitter (`src/schema/ddl-generator.ts` +
`src/schema/catalog.ts`, whose output is re-parsed on reload) emitted four
identifier positions **bare**, so a reserved-word-named collation / module /
vtab-arg key / assertion produced DDL that fails to re-parse. Same bug class as
the AST-stringifier fix (`reserved-word-identifier-emit-roundtrip`, in
`complete/`); the AST round-trip suites structurally can't reach this generator,
so the gap was uncovered.

All four positions now route through `quoteIdentifier` (conditional — quotes only
reserved words / non-bare-valid names, leaving ordinary names bare):

- **COLLATE name** — `ddl-generator.ts:88`
- **USING module name** — `ddl-generator.ts:188` *and* `:199` (both emit paths in
  `formatUsingClause`: the no-db branch and the db-context branch)
- **vtab-arg key** — `ddl-generator.ts:206`
- **CREATE ASSERTION name** — `catalog.ts:305`

`quoteIdentifier` (not `quoteName`) is the correct choice here: the store DDL
convention keeps these operand identifiers bare (`USING store`, `COLLATE NOCASE`,
`collation = 'NOCASE'`, `cache_size = 100`), which the quereus-store ddl-generator
spec pins; an unconditional `quoteName` would have regressed those assertions.
Structural names (table/column/schema/index/PK) stay unconditionally quoted via
`quoteName` — that two-policy split is now documented inline (see review fix
below).

The parser emitter-sync banner (`parser.ts:39-44`) was corrected to list the
three real emitters and drop a stale path that does not exist.

## Tests

`packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts` — schema → DDL
→ parse round-trip driven off `Object.keys(KEYWORDS)` (whole-lexer sweep, can't
drift). 9 tests covering COLLATE / USING (both branches) / vtab-arg key survival,
the CREATE ASSERTION name-quoting via `collectSchemaCatalog`, and no-over-quoting
guards for the three bare-emit sites. All passing.

## Review findings

### Process
Reviewed the implement diff (`965737a3`) first, with fresh eyes, then the
handoff. Read every touched file plus the consumers the change reaches
(`schema/manager.ts importSingleDDL`, `schema-differ.ts`, store-module
`rehydrateCatalog`, `runtime/emit/create-assertion.ts`, `emit/ast-stringify.ts
quoteIdentifier`). Ran build, lint, and the full Mocha suite.

### Correctness — verified, no regressions
- All four positions confirmed routed through `quoteIdentifier`; both
  `formatUsingClause` emit paths covered (the handoff's flagged follow-up edit to
  line 199 is present).
- `quoteIdentifier` vs `quoteName` choice is correct and forced by the store
  spec's bare-emit assertions; no position needs unconditional quoting that was
  left conditional, and vice versa.
- Swept the generator for any *other* bare identifier emission: only
  `col.logicalType.name` (a type-name position, distinct grammar slot, not in
  scope) remains bare. No missed identifier position.

### Handoff gap #1 (assertion `ddl` not fully re-parseable) — confirmed
pre-existing, **filed as a new ticket**. Traced the consumers:
`importSingleDDL` rejects assertion statement types (table/index only), and the
differ keys `actualCatalog.assertions` **by name**, never reading `.ddl`. So the
assertion catalog `ddl` is consumed for hash + display only and is never
re-parsed today — the name-quoting fix is correct and harmless. But the embedded
`violationSql` (`select 1 where not (...)`) in the `CHECK (...)` slot makes the
string non-reparseable independent of reserved words — a latent landmine for any
future reload/replay path. Filed `backlog/assertion-catalog-ddl-not-reparseable.md`.

### Handoff gap #2 (vtab-arg value-side round-trip not asserted) — accepted as
low-risk. The store spec covers value formatting (`collation = 'NOCASE'`,
`cache_size = 100`); values are always emitted as SQL literals and the key (this
ticket's concern) is asserted. No new test warranted.

### Maintainability — minor, fixed inline
The `quoteName` doc comment (`ddl-generator.ts:27`) claimed `quoteIdentifier` "is
for AST stringification," which became inaccurate once this file started using it
for four positions. Rewrote it to document the two-policy split (structural names
→ unconditional `quoteName`; operand identifiers → conditional `quoteIdentifier`)
and why. Comment-only; lint re-run green.

### Docs
Banner in `parser.ts` is the only cross-emitter doc and is now accurate (verified
the removed `quereus-store/src/common/ddl-generator.ts` path does not exist and
the three listed emitters are the complete set). No other doc references the
generator's quoting behavior.

### Test coverage — adequate
Happy path, reserved-word edge (whole-KEYWORDS sweep), and over-quoting
regression guards are all present across both emit branches and the assertion
site. The store spec (16/16) pins the bare-emit convention as a regression floor.

## Validation (all green)
- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0 (re-run after inline doc fix)
- full Mocha suite → **4809 passing**, 9 pending, exit 0
- new spec (targeted via `--grep`) → 9 passing
- `quereus-store/test/ddl-generator.spec.ts` → no regression (bare-emit asserts intact)

### Deferred (out-of-band, not agent-runnable)
- `yarn test:store` — full LevelDB logic suite exercises the real reload path
  this generator feeds. Nothing in the diff should affect it (bare-emit
  assertions preserved), but a CI/reviewer run is recommended as a persistence
  sanity check.

## Follow-up tickets filed
- `backlog/assertion-catalog-ddl-not-reparseable.md` — make the assertion catalog
  `ddl` faithful re-parseable SQL (emit `CHECK (<checkExpression>)` instead of the
  stored `violationSql`), or rename/document the field if a non-reparseable
  descriptor is intended.
