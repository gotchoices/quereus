description: `DeclareSchema` item stringifier rewrite — placeholders replaced with real bodies that round-trip through `parse → stringify → parse` for all five declared kinds (table, index, view, seed, assertion).
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
----

## Outcome

`declareItemToString` now dispatches per-kind to real formatters (`declaredTableToString`, `declaredIndexToString`, `declaredViewToString`, `declaredSeedToString`, `declaredAssertionToString`) that emit syntactically complete SQL matching the parser's declared-item grammar. Three shared helpers (`tableBodyDefsToString`, `moduleClauseToString`, `contextClauseToString`) and `indexedColumnsToString` are extracted from `createTableToString` / `createIndexToString` so the declared and standalone forms share emission. A new `sqlValueToSqlLiteral` renders `SqlValue` seed data as SQL literals (single-quoted strings with `''` escaping, `x'…'` for blobs, keywords for `null`/`true`/`false`, numeric for `number`/`bigint`).

Grammar deltas honored:
- Declared `table` puts `using <module>(args)` before the body (standalone puts it after).
- Declared `index`/`view` omit `create`, `if not exists`, `temp`; declared `index` omits `where`.
- Declared `assertion` omits `create`.

## Review findings

- **Code quality (correctness, DRY, modularity, scope)** — checked. The per-kind formatters each map cleanly to their parser counterpart (`declareTableItem`, `declareIndexItem`, `declareViewItem`, `declareSeedItem`, `declareAssertionItem`). Shared helpers (`tableBodyDefsToString`, `moduleClauseToString`, `contextClauseToString`, `indexedColumnsToString`) are behavior-preserving for the two existing call sites and remove duplication rather than introduce abstraction overhead. Switch in `declareItemToString` is exhaustive over the `DeclareItem` union; TypeScript would flag a missing case. Scope is tight — no drive-by refactors. No findings.
- **`sqlValueToSqlLiteral` coverage** — checked. All seven `SqlValue` variants are handled. The `JsonSqlValue` branch is documented as a known limit (becomes a quoted JSON string; parser literals don't reconstruct objects) and is consistent with the parser's current `expression() → literal` constraint on seed values. Acceptable as scoped; not a blocker.
- **Seed grammar paths** — checked. Anonymous `seed T ((…))` form covered by 4 unit tests + 100-run property test. The optional `seed T values (cols) values ((…))` column-list form was a coverage gap — no unit test, and the property arb never set `columns`. **Fixed inline**: added `preserves declared seed with explicit column list` to `ast-stringify.spec.ts` exercising round-trip for `seed T values (id, name) values ((1, 'Alice'), (2, 'Bob'))`. Passes.
- **Item separator / block bracketing** — checked. `declareSchemaToString` inserts `;` between items; `selectToString` does not emit `;`, so view bodies cannot collide with item separators. Parser accepts the `;` as optional (`this.match(TokenType.SEMICOLON)`).
- **Identifier quoting** — checked. All emitted names (`table`, `index`, `view`, `seed`, `assertion`) go through `quoteIdentifier`, so reserved-word or punctuated names round-trip. Property test draws from `identArb` which mixes plain identifiers with keyword-collision candidates.
- **Pre-existing `moduleClauseToString` JSON.stringify quirk** — checked. Extracted helper preserves the pre-existing behavior (uses `JSON.stringify` for arg values, which double-quotes strings). Handoff explicitly flags this as latent and unchanged. Not exercised by any test or arb. Out of scope here; **not filed** as a fix ticket since the field is already a known follow-up area and nothing in the declared-table path makes it worse.
- **Tests run** — `yarn workspace @quereus/quereus run test` 3283 passing, 0 failing (was 3282 + the new unit test). `yarn workspace @quereus/quereus run lint` clean. No regressions, no pre-existing failures surfaced.
- **Docs** — checked. No reference docs describe declared-item stringification; the source-level comment block at the head of `ast-stringify.ts` covers general formatting conventions and remains accurate. Nothing to update.

## What was checked but **not** changed

- `JsonSqlValue` seed values do not round-trip back to objects (become quoted JSON strings). Acknowledged limit, parser-side constraint, not a stringifier bug.
- Property-test arb intentionally constrains inner statements (no `moduleArgs`, no `contextDefinitions`, no schema-qualified declared-table names). These are forward-compat decisions tied to parser support for the declared form — separate tickets if broader coverage is desired.
- `moduleClauseToString` `JSON.stringify` quirk — pre-existing in the standalone `createTableToString` path; not introduced by this change.
