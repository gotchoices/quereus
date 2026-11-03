---
description: Some things a table declares are thrown away when the database saves its definition: a column's rule-violation instruction (skip the row, roll back) and a table's per-statement parameters. After reopening, the first quietly falls back to the default behaviour and the second leaves the table refusing every write, or refusing to load at all.
architecture: docs/schema.md
files:
  - packages/quereus/src/schema/ddl-generator.ts (`generateTableDDLInternal`, `formatColumnDef`, `nullabilityAnnotation`, `pkConflictClause` — the emission site for both arms)
  - packages/quereus/src/emit/ast-stringify.ts (~1872 `contextClauseToString` — the renderer to share for arm 2)
  - packages/quereus/src/runtime/emit/alter-table.ts (~2702 `buildConstraintsFromColumn` — arm 3)
  - packages/quereus/src/schema/table.ts (`resolvePkDefaultConflict` ~1336, `columnDefToSchema` ~565-583, `mutationContextVarToSchema` ~646, the `rekeySchemaPrimaryKey` NOTE ~842)
  - packages/quereus/src/parser/parser.ts (~4392 `parseMutationContextDefinitions`, ~2720 trailing WITH clauses)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (round-trip harness; three shapes need new expected text)
  - packages/quereus/test/alter-table-conformance.spec.ts (~857 the "differs ONLY in the PRIMARY KEY clause" test — extend it)
  - packages/quereus-store/test/pk-conflict-action-reopen.spec.ts (model for the reopen test)
  - docs/schema.md (~337-339 — the ON CONFLICT paragraph and its "one gap remains" follow-up)
repro: verified
---

# Table declarations lost by the canonical `CREATE TABLE` emitter

Quereus persists a table by regenerating its `CREATE TABLE` text with `generateTableDDL` and re-parsing that text on reopen. The same text also builds the shadow table for the `ALTER PRIMARY KEY` fallback rebuild, and is what a sync peer re-executes (`vtab/memory/module.ts` ~419). So anything the generator omits is lost on reopen, on a rebuild-path re-key, and on replicas.

## Reproduced

Each of these was run against the current tree: create, `generateTableDDL` (no `db`), execute the text in a fresh `Database`, inspect. `T` is `TableSchema.primaryKeyDefaultConflict`; `X` is `ColumnSchema.defaultConflict`.

| Declared | Original | After round-trip | Effect |
|---|---|---|---|
| `id integer primary key, x integer not null on conflict ignore` | x: IGNORE | x: none | `insert values (2, null)` skips the row live, throws `NOT NULL constraint failed` after reload |
| `x integer null on conflict ignore` (non-key) | x: IGNORE | x: none | action lost |
| `a integer not null on conflict ignore, b, c, primary key (a, b)` | T none, a: IGNORE | T IGNORE, a: none | composite key member loses its NOT NULL action; a table-level action is minted that nobody declared |
| `a … on conflict rollback, b … on conflict ignore, primary key (a, b)` | a: ROLLBACK, b: IGNORE | T ROLLBACK, a/b: none | both NOT NULL actions lost |
| `a … on conflict abort, b … on conflict replace, primary key (a, b)` | a: ABORT, b: REPLACE | none anywhere | b's action lost |
| `a, v, primary key (a) on conflict ignore` | T IGNORE, a: none | T none, a: IGNORE | a NOT NULL violation on `a` goes from ABORT to skip-the-row; a later `ALTER PRIMARY KEY` also behaves differently (see the NOTE on `rekeySchemaPrimaryKey`) |
| `a not null on conflict rollback, v, primary key (a) on conflict replace` | T REPLACE, a: ROLLBACK | T none, a: REPLACE | a's NOT NULL action overwritten |
| `a not null on conflict replace, v, primary key (a) on conflict abort` | T ABORT, a: REPLACE | none | a's action lost |
| `… with context (cap integer)`, a CHECK reads `cap` | `mutationContext: [cap]` | absent | text re-executes without error, then every write fails `Column not found: cap` |
| `… v integer default n … with context (n)` | `mutationContext: [n]` | re-parse **fails** | `DEFAULT for column 'v' … may not reference a bare column` — the emitted text is not valid DDL for its own table |
| `alter table t rename column x to z` on the first row above | x: IGNORE | z: none | **no reload needed** — see arm 3 |

The table also shows the original ticket undersold arm 1: it was framed as non-key columns, but composite-key members and table-level single-column keys drift too, because the generator folds two separate records into one clause.

The session-elided form (`generateTableDDL(schema, db)`) renders the first row as `"x" INTEGER` — no annotation to attach to.

## Arm 1 — the emission rule: each record rides its own clause

A table has two independent records: `T` (table-level, the key's action) and each column's `X` (written by a column's `primary key` / `not null` / `null` clause, which share one slot; last clause wins on re-parse). Consumers read them differently: `runtime/row-constraints.ts` reads `X` for a NOT NULL violation, and `resolvePkDefaultConflict` reads `T`, else the first key column's `X`, for a duplicate key. Today's generator feeds the resolved key action into the key clause and drops everything else, which is why a record migrates or vanishes.

The fix replaces resolve-then-emit with a one-to-one mapping, so a re-parse reproduces both records exactly:

- **`X` rides the column.** Emit `NOT NULL ON CONFLICT X` / `NULL ON CONFLICT X` on the nullability annotation, for every column that does not carry the inline `PRIMARY KEY` clause. On the column that does, emit it on that clause (`PRIMARY KEY [DESC] ON CONFLICT X`) — one slot, so one clause. The parser already accepts `on conflict` after `null` and `not null` (`columnConstraint`).
- **`T` rides the table-level clause.** `PRIMARY KEY (...) ON CONFLICT T`. A single-column key renders **inline only when there is no `T` to emit**; otherwise it renders table-level, `PRIMARY KEY ("a") ON CONFLICT T`, because an inline clause would re-parse `T` onto the column slot. The table-level branch already handles `DESC`; its guard changes from `length > 1` to "not rendered inline".
- **Force the annotation.** When a column has `X` to emit in the with-`db` form, emit the annotation even if it matches the session default (decided on the ticket; the added text only appears on columns that declare an action). The inline-clause column does not need it.
- **ABORT.** `X` is emitted verbatim including ABORT. Eliding it is not neutral: `resolvePkDefaultConflict` takes the first defined key column, so in `a … on conflict abort, b … on conflict replace, primary key (a, b)` eliding a's ABORT would flip the key's action to REPLACE. `T = ABORT` stays elided only when no key column has an `X` — that is the existing "PK with ON CONFLICT ABORT emits no ON CONFLICT" case, where it is genuinely equal to absence. When a key column has an `X`, `T = ABORT` is emitted, since it outranks that `X`.

Sketch:

```ts
/** T as it must appear in the text: ABORT is elided only where nothing depends on it outranking a column. */
function emittedTableKeyAction(schema: TableSchema): ConflictResolution | undefined {
	const t = schema.primaryKeyDefaultConflict;
	if (t !== ConflictResolution.ABORT) return t;
	const keyColumnDeclares = schema.primaryKeyDefinition.some(pk => schema.columns[pk.index].defaultConflict !== undefined);
	return keyColumnDeclares ? t : undefined;
}

const tableAction = emittedTableKeyAction(tableSchema);
const inlinePkIndex = tableSchema.primaryKeyDefinition.length === 1 && tableAction === undefined
	? tableSchema.primaryKeyDefinition[0].index
	: -1;
```

`resolvePkDefaultConflict` is no longer imported by the generator; `pkConflict` no longer threads through `formatColumnDef`. Keep `resolvePkDefaultConflict` itself — the runtime and lens prover use it.

**What changes in existing emitted text** (old persisted text still re-parses; no migration):

- `primary key (a) on conflict replace`: `"a" … NOT NULL PRIMARY KEY ON CONFLICT REPLACE` → `"a" … NOT NULL, …, PRIMARY KEY ("a") ON CONFLICT REPLACE`.
- `a … not null on conflict replace, primary key (a, b)`: `PRIMARY KEY ("a", "b") ON CONFLICT REPLACE` → `"a" INTEGER NOT NULL ON CONFLICT REPLACE, …, PRIMARY KEY ("a", "b")`.

Fixed-point behaviour is unaffected: nothing is folded, so the first emission already equals the second. `docs/schema.md` ~337 currently describes the folding as necessary; rewrite it.

On the re-key rebuild path, this also brings the shadow in line with an in-place re-key: a column-declared `a integer primary key on conflict replace` re-keyed to `(b)` keeps `a`'s `X` and gives the new key no action, as the `rekeySchemaPrimaryKey` NOTE describes.

## Arm 2 — `with context (…)`

`generateTableDDLInternal` emits nothing for `TableSchema.mutationContext`. `emit/ast-stringify.ts` `contextClauseToString` already renders the clause for the declarative path. Extract a shared exported renderer over `AST.MutationContextVar[]` (`contextClauseToString` delegates to it), lift each `MutationContextDefinition` to `{ name, dataType: logicalType.name, notNull }`, and push the result between the `maintained` clause and `WITH TAGS` (the parser takes the trailing WITH clauses in any order; `createTableToString` uses context then tags).

**Correction to the earlier wording of this ticket:** it asked for an explicit nullability on each variable. The grammar has no `NOT NULL` form for a context variable — `parseMutationContextDefinitions` accepts only an optional `NULL` and sets `notNull = !matchedNull`, so `cap integer not null` is a parse error. A bare variable means NOT NULL under any session default, since the parser always sets the field and `mutationContextVarToSchema`'s `defaultNotNull` never applies. So the shared renderer's output (bare, or ` NULL`) is already session-independent. No parser change.

Types verified to parse in this position: INTEGER, TEXT, REAL, BLOB, DATE, TIMESTAMP, JSON, ANY. An untyped variable infers BLOB and emits `n BLOB`, which is stable. A reserved-word name quotes via `quoteIdentifier`.

Maintained tables cannot declare context variables (rejected at declaration), so `generateMaintainedTableDDL` emits no clause in practice; no special-casing needed.

Same fix also repairs the sync-peer path and the rebuild path for context (`repro: static` for those two — both call the same generator, not run separately).

## Arm 3 — `ALTER TABLE … RENAME COLUMN` drops `X` with no reload

`buildConstraintsFromColumn` (`runtime/emit/alter-table.ts` ~2702) rebuilds a `ColumnDef` AST for the module, which re-derives the column via `columnDefToSchema`, but it does not pass the action. Verified on the memory module: `x … on conflict rollback` renamed to `z` has no `defaultConflict`. Fix: `onConflict: col.defaultConflict` on the `notNull` / `null` constraint it always pushes. Different site from arms 1 and 2, but the same user-visible loss and a one-liner, so it stays here. Without it the harness shape below cannot pass.

## Tests

In `packages/quereus/test/table-ddl-round-trip.spec.ts`:

- Add `columnActionSpelling(schema)` (`name: ACTION|-`, reading raw `defaultConflict`) and compare original against re-parsed for **every** shape. Also compare raw `T` with ABORT normalized to absent. This is the generic assertion; the current `conflictSpelling` cannot see any of the losses above.
- `expect(ddl).to.not.contain('ON CONFLICT')` currently fires when `expectedConflict` is undefined; a non-key action now legitimately emits. Gate it on a new optional `expectedColumnActions`.
- New shapes, one per row of the table above except the first two (merge those): non-key NOT NULL, non-key NULL, composite member, two differing members, abort-then-replace, table-level single with `ignore`, `T` and `X` differing, `T = ABORT` with `X`, and a rename shape (`statements` ending in `alter table t rename column …`).
- Update `expectedText` on three existing shapes: 'narrow composite PK, action declared on a key column', 'all-columns PK, action declared on a key column', 'narrow table-level PK with ON CONFLICT'.
- A case for the with-`db` form: `generateTableDDL(schema, db)` re-parsed in the same session keeps the action.
- Arm 2: emit, re-execute, insert with `with context cap = 10` succeeds and violating `cap` fails; second emission byte-identical; a nullable variable, a reserved-word name, a `DEFAULT n` reading a variable, and a table also carrying `with tags`.

In `alter-table-conformance.spec.ts` ~857, add a non-key `on conflict ignore` column and a `with context` variable to the rebuild test's table: its before/after text comparison then covers the third consumer without a new test.

One reopen test in `quereus-store/test/`, modelled on `pk-conflict-action-reopen.spec.ts`: persist, close, `rehydrateCatalog`, then assert `not null on conflict ignore` still skips and a `with context` table is writable. **Use IGNORE, not ROLLBACK**: an `on conflict rollback` action does not actually roll back when the statement runs through `db.exec` (see `bug-rollback-conflict-action-not-honored`), so a rollback-based test cannot tell live from reloaded behaviour.

## TODO

- Reproduce first: add the harness shapes and `columnActionSpelling`; confirm they fail before changing the generator.
- `ddl-generator.ts`: implement the one-to-one emission (`emittedTableKeyAction`, column clause, inline rule, forced annotation in `nullabilityAnnotation`); drop the `pkConflict` parameter and the resolve import; remove the `formatColumnDef` `NOTE:` that describes this gap; rewrite the comments at ~131-138 and ~569-573.
- `ast-stringify.ts`: export the shared context renderer; emit it from `generateTableDDLInternal`.
- `alter-table.ts`: carry `onConflict` in `buildConstraintsFromColumn`.
- Update the three existing `expectedText` values and the harness header comment; extend the conformance rebuild test; add the store reopen test.
- `docs/schema.md`: replace ~337-339 with the one-to-one rule, and note that `with context` is emitted. Update the module-level doc comment in `ddl-generator.ts` to say the forced annotation is the one exception to the elision.
- `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/store test`, `yarn lint`, `yarn test:store` (this changes what the store persists).
