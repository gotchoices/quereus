description: The assertion catalog `ddl` string is not valid re-parseable SQL — it embeds the stored `violationSql` (a full `select 1 where not (...)` query) inside the `CHECK (...)` slot, which the parser rejects as a CHECK expression. Currently inconsequential (the field is consumed by-name only), but a latent landmine for any future reload/replay path.
files: packages/quereus/src/schema/catalog.ts, packages/quereus/src/runtime/emit/create-assertion.ts, packages/quereus/src/schema/assertion.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/schema/schema-differ.ts
----

## Problem

`assertionSchemaToCatalog` (`schema/catalog.ts:302`) emits:

```
CREATE ASSERTION <name> CHECK (<violationSql>)
```

where `violationSql` is set in `runtime/emit/create-assertion.ts:24` to a **full
SELECT**:

```
select 1 where not (<checkExpression>)
```

So the emitted catalog `ddl` is, concretely, e.g.:

```
CREATE ASSERTION my_assert CHECK (select 1 where not (1 = 1))
```

That is **not** a valid `CREATE ASSERTION` statement: the parser's
`createAssertionStatement` (`parser/parser.ts:2786`) calls `this.expression()`
after `CHECK (`, and a leading `select` is not an expression — so the assertion
catalog `ddl` never round-trips through `parse()`, independent of reserved-word
quoting.

## Why it is currently harmless (do not assume it stays that way)

Verified during the `ddl-generator-reserved-word-identifier-emit` review:

- `manager.importSingleDDL` (`schema/manager.ts:2136`) only handles
  `createTable` / `createIndex` and **throws** on any other statement type, so
  the store rehydrate path (`rehydrateCatalog → importCatalog`) never feeds
  assertion `ddl` back to the parser.
- The schema differ (`schema-differ.ts:407`) consumes
  `actualCatalog.assertions` **by name only** (`a.name.toLowerCase()`); it never
  reads `a.ddl`. Assertion *creation* DDL for migrations is generated fresh from
  the declared AST via `createAssertionToString`, not from the catalog `ddl`.

So today the catalog assertion `ddl` is used only for (a) schema-hash input and
(b) display. Both tolerate a non-reparseable string.

## Why it is still worth fixing

The string is self-describing as `CREATE ASSERTION ... CHECK (...)` but is not
valid SQL — a maintainer (or a future feature: assertion rehydrate, schema
export/replay, "show me the DDL" tooling) will reasonably assume it re-parses
and be bitten. Either:

- make the emitted `ddl` a faithful `CREATE ASSERTION <name> CHECK (<expr>)`
  using the stored `checkExpression` (the AST is available on
  `IntegrityAssertionSchema.checkExpression`) via `expressionToString`, **or**
- if a non-reparseable descriptor is intentional, rename the field / document it
  clearly so no consumer treats it as DDL.

Note: `IntegrityAssertionSchema` carries `checkExpression`, so option 1 is
straightforward — emit `CHECK (${expressionToString(checkExpression)})` instead
of the `violationSql`, and add the assertion case to a re-parse round-trip test.

## Scope / non-goals

- This is **not** about reserved-word quoting — that is already fixed (the name
  routes through `quoteIdentifier`). This is about the CHECK-slot contents.
- Decide deliberately whether assertion `ddl` should be re-parseable at all
  before implementing; if the answer is "no", the fix is documentation + a field
  rename, not a code change to the emitted SQL.
