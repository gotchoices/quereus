description: Make the assertion catalog `ddl` a faithful, re-parseable `CREATE ASSERTION <name> CHECK (<expr>)` by emitting the stored `checkExpression` AST via `expressionToString`, instead of embedding the `select 1 where not (...)` `violationSql` in the CHECK slot. Add an assertion-catalog re-parse round-trip test.
files: packages/quereus/src/schema/catalog.ts, packages/quereus/src/runtime/emit/create-assertion.ts, packages/quereus/src/schema/assertion.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts
----

## Problem (verified)

`assertionSchemaToCatalog` (`schema/catalog.ts:316`) currently emits:

```ts
ddl: `CREATE ASSERTION ${quoteIdentifier(assertionSchema.name)} CHECK (${assertionSchema.violationSql})`
```

`violationSql` is built in `runtime/emit/create-assertion.ts:24` as a **full
SELECT** — `select 1 where not (<exprSql>)`. So the emitted catalog `ddl` is,
concretely:

```
CREATE ASSERTION my_assert CHECK (select 1 where not (1 = 1))
```

The parser's `createAssertionStatement` (`parser/parser.ts:2786`) calls
`this.expression()` after `CHECK (`, and a leading `select` is not an
expression, so this `ddl` never round-trips through `parse()`. It is
self-describing as DDL but is not valid SQL.

## Design decision — settled (option 1: make it faithful)

Emit the CHECK slot from the stored `checkExpression` AST, which
`IntegrityAssertionSchema` already carries (`schema/assertion.ts:27`), via
`expressionToString` (`emit/ast-stringify.ts`). This is the same call that
`create-assertion.ts:23` already uses to build the violation query, so it is
already proven to produce a parseable expression for this exact input.

Why option 1 over "rename the field / document non-reparseable":

- The string literally announces itself as `CREATE ASSERTION ... CHECK (...)`;
  a faithful, parseable form is strictly more useful and removes the latent
  landmine for any future rehydrate / schema-export / "show DDL" tooling.
- The fix is tiny and uses existing, already-exercised machinery
  (`createAssertionToString` at `ast-stringify.ts` does exactly
  `create assertion <name> check (<expr>)` — the catalog generator just needs
  the same CHECK-slot contents, keeping its uppercase keyword style).
- No back-compat barrier: `manager.importSingleDDL` throws on assertion
  statements, so assertion `ddl` is never fed back to the parser today; the
  schema differ reads assertions **by name only**. Per AGENTS.md, back-compat
  is not yet a concern.

### Keyword casing — keep uppercase

Keep the catalog generator's existing uppercase style: emit
`CREATE ASSERTION ${quoteIdentifier(name)} CHECK (${expr})`. Do **not** switch
to the lowercase `createAssertionToString` AST-stringifier form — the existing
passing tests assert `CREATE ASSERTION "select" CHECK` /
`CREATE ASSERTION my_assert CHECK` (uppercase) and the sibling generator sites
(`ddl-generator.ts`) all emit uppercase keywords. Only the CHECK-slot
**contents** change.

### Target shape

```ts
import { ..., quoteIdentifier, expressionToString } from '../emit/ast-stringify.js';

function assertionSchemaToCatalog(assertionSchema: IntegrityAssertionSchema): CatalogAssertion {
	// Faithful, re-parseable CHECK expression from the original AST when present.
	// `checkExpression` is absent only for assertions reconstructed from
	// persisted `violationSql` alone — a path that does not exist today
	// (importSingleDDL throws on assertion DDL); the fallback keeps a
	// descriptive (non-reparseable) string for that hypothetical case rather
	// than crashing. See assertion.ts:21-27.
	const checkSql = assertionSchema.checkExpression
		? expressionToString(assertionSchema.checkExpression)
		: assertionSchema.violationSql;
	return {
		name: assertionSchema.name,
		ddl: `CREATE ASSERTION ${quoteIdentifier(assertionSchema.name)} CHECK (${checkSql})`,
	};
}
```

`expressionToString` is currently imported by `create-assertion.ts` from
`emit/ast-stringify.js`; `catalog.ts` already imports `quoteIdentifier` from the
same module — just add `expressionToString` to that existing import list
(`catalog.ts:5`).

## Edge cases & interactions

- **`checkExpression` absent.** Optional per `assertion.ts:27`. Today every
  assertion is created through `emitCreateAssertion`, which always sets it
  (`create-assertion.ts:40`), so the primary path always fires. The fallback to
  `violationSql` exists only so the function never throws on a future
  reconstruct-from-`violationSql` assertion; document it (comment above) and do
  not silently drop the field.
- **Reserved-word assertion name.** Name still routes through
  `quoteIdentifier` — keep that. Both existing name-quoting tests
  (`ddl-generator-roundtrip-positions.spec.ts:273-288`) must continue to pass
  unchanged.
- **Expression with reserved-word / quoted identifiers inside the CHECK.**
  Covered by `expressionToString`'s own quoting; the new round-trip test should
  include at least one identifier-bearing predicate (e.g. a column reference) so
  this is exercised, not just `1 = 1`.
- **Schema-hash impact.** Confirm the consumer before asserting "no behavioral
  change": `computeSchemaHash` (`schema/schema-hasher.ts`) hashes the *declared*
  schema via `generateDeclaredDDL`, **not** `collectSchemaCatalog`, so the
  declared-schema hash is unaffected. If any *actual-catalog* hash path consumes
  `catalog.assertions[].ddl`, its value changes (acceptable: no persistence of
  assertions, back-compat not a concern) — note it in the implement handoff
  rather than treating a changed hash as a regression.
- **Display consumers.** `func/builtins/schema.ts` and `func/builtins/explain.ts`
  read `violationSql` directly (not the catalog `ddl`), so assertion *display*
  of the violation query is unchanged. Only the catalog `ddl` string changes.
- **Differ / migration generation.** `schema-differ.ts` builds assertion
  creation DDL from the declared AST via `createAssertionToString`, not from the
  catalog `ddl`; it reads `actualCatalog.assertions` by name only. Unaffected —
  do not touch the differ.

## Tests

Extend `test/ddl-generator-roundtrip-positions.spec.ts` (the canonical
generator round-trip suite). Two changes:

- **Update the file header.** The header (lines ~22-28) and the
  `describe('Generator: CREATE ASSERTION name ...')` block comment (~257-262)
  currently document the *deferral* of a full assertion re-parse ("intentionally
  not attempted … embeds `violationSql` …"). That deferral is exactly what this
  ticket removes — rewrite those notes to state the `ddl` is now faithful and
  re-parseable.

- **Add a re-parse round-trip test** in the existing
  `describe('Generator: CREATE ASSERTION name (collectSchemaCatalog)')` block:
  - `await db.exec('create assertion my_assert check (1 = 1)')`,
    `collectSchemaCatalog(db, 'main')`, find the assertion, then
    `parse(a.ddl)` and assert `stmt.type === 'createAssertion'` and the
    re-parsed name matches. Expected: the `ddl` now parses without throwing
    (it previously would have thrown on the embedded `select`).
  - Add an identifier-bearing variant to exercise expression quoting: create a
    table and an assertion whose CHECK references a column
    (e.g. `create assertion a2 check ((select count(*) from t) = 0)` — confirm
    the supported assertion expression form against
    `test/logic/95-assertions.sqllogic` and mirror a shape used there), then
    `parse(a.ddl)` round-trips to `createAssertion`. If a subquery predicate is
    awkward to assert structurally, a simpler column-reference scalar predicate
    that the parser accepts in the CHECK slot is sufficient — the point is to
    cover an identifier inside the CHECK, not just a literal.
  - Keep the existing name-quoting asserts (`CREATE ASSERTION "select" CHECK`,
    no-over-quote on `my_assert`) — they should still pass verbatim, now
    additionally backed by a successful `parse()`.

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/assert-ddl.log; tail -n 60 /tmp/assert-ddl.log`
  — focus on `ddl-generator-roundtrip-positions`, `emit-create-assertion`, and
  the assertion sqllogic suite.
- Lint the touched files (single-quote the glob on Windows per AGENTS.md).

## TODO

- Add `expressionToString` to the `ast-stringify.js` import in `catalog.ts:5`.
- Rewrite `assertionSchemaToCatalog` (`catalog.ts:316`) to emit the CHECK slot
  from `checkExpression` (with the documented `violationSql` fallback), keeping
  uppercase keywords and `quoteIdentifier(name)`.
- Update the deferral notes in
  `test/ddl-generator-roundtrip-positions.spec.ts` (file header + assertion
  describe-block comment) to reflect that the assertion `ddl` is now faithful.
- Add the assertion-catalog re-parse round-trip test(s) (literal CHECK +
  identifier-bearing CHECK).
- Run build, tests, and lint; in the review handoff, note whether any
  actual-catalog hash consumer's value shifts as a result of the `ddl` change.
