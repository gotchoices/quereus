---
description: Saving a table's definition used to lose a column's rule-violation instruction (skip the row, roll back) and the table's per-statement parameters, so reopened tables behaved differently or refused writes. Both now survive a save and reopen, and also survive renaming a column.
architecture: docs/schema.md
files:
  - packages/quereus/src/schema/ddl-generator.ts (`onConflictClause`, `emitContextClause`, `formatColumnDef`, `nullabilityAnnotation`)
  - packages/quereus/src/schema/table.ts (`columnSchemaToColumnDef`, new in review)
  - packages/quereus/src/emit/ast-stringify.ts (`contextClauseToString` now exported, takes the variable list)
  - packages/quereus/src/runtime/emit/alter-table.ts (rename site)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts (backing-column rename and add sites)
  - packages/quereus/src/planner/building/alter-table.ts (`NOTE:` on `addConstraint`)
  - packages/quereus/test/table-ddl-round-trip.spec.ts
  - packages/quereus/test/alter-table-conformance.spec.ts (~856)
  - packages/quereus-store/test/table-declaration-reopen.spec.ts (new)
  - packages/quereus-store/test/pk-conflict-action-reopen.spec.ts (header comment only)
  - docs/schema.md (generator section)
repro: verified
---

# Table declarations lost by the canonical `CREATE TABLE` emitter

Quereus persists a table by regenerating its `CREATE TABLE` text with `generateTableDDL` and re-parsing it on reopen. The same text builds the shadow table for the `ALTER PRIMARY KEY` rebuild and is what a sync peer re-executes. Anything the generator omits is lost in all three places.

## What changed

A table has two independent `ON CONFLICT` records: the table-level one (`TableSchema.primaryKeyDefaultConflict`) and each column's own (`ColumnSchema.defaultConflict`). The generator used to resolve them into one action and put that on the key clause. It now maps them one-to-one:

- **The column's action rides the column:** on the inline `PRIMARY KEY` clause if the column has one, otherwise as `NOT NULL ON CONFLICT X` / `NULL ON CONFLICT X`. In the with-`db` form the annotation is forced for such a column, even when it matches the session default.
- **The table's action rides the table-level clause.** A single-column key renders inline only when the table has no action.
- **A declared ABORT is emitted like any other action**, on either record. Review removed the elision the implement stage kept for a table-level ABORT (see findings).

`with context (…)` is now emitted between the `maintained as` clause and `WITH TAGS`, through the renderer the AST path uses.

Column rename now keeps the action. `columnSchemaToColumnDef` is the one lift from a live column back to the definition a module's rename hook re-derives it from, and it also carries tags and defaults.

Text changes in persisted DDL (old text still re-parses, no migration):

- `primary key (a) on conflict replace`: `"a" … NOT NULL PRIMARY KEY ON CONFLICT REPLACE` → `"a" … NOT NULL, …, PRIMARY KEY ("a") ON CONFLICT REPLACE`
- `primary key (a) on conflict abort`: `"a" … NOT NULL PRIMARY KEY` → `"a" … NOT NULL, …, PRIMARY KEY ("a") ON CONFLICT ABORT`
- `a … not null on conflict replace, primary key (a, b)`: `PRIMARY KEY ("a", "b") ON CONFLICT REPLACE` → `"a" INTEGER NOT NULL ON CONFLICT REPLACE, …, PRIMARY KEY ("a", "b")`

## Review findings

Read the diff from `ticket(implement): bug-non-key-column-conflict-action-dropped-from-ddl` first, then ran about 40 extra table shapes through create, generate and re-parse against the built engine, comparing both raw records, context variables and second-emission text.

**Fixed in this pass**

- **Table-level ABORT lost on reopen, with a visible effect (reproduced).** The implement stage elided a table-level ABORT unless a key column declared an action, on the reasoning that it then equals absence. It does not. With `a integer, b integer not null on conflict replace, primary key (a) on conflict abort` then `alter primary key (b)`, a duplicate `b` threw in the original session, but after a save and reopen it silently replaced the row. The generator now emits a declared ABORT unconditionally and `emittedTableKeyAction` is gone, so the one-to-one rule has no exception. The harness's raw table-record comparison no longer normalizes ABORT, and the existing shape that pinned the elision now pins the emission. This reverses that shape's stated expectation, so a table that declares `on conflict abort` gets the longer text above. After the fix the same sequence throws in both cases.
- **Rename lost a column's tags, and a maintained table's rename lost its default too (both reproduced).** `x integer with tags (k = 1)` renamed to `z` came back with no tags. A maintained table's `v integer default 3` lost its default when a source rename reached it, contradicting the deleted helper's comment that backing columns never carry defaults. Both losses were pre-existing and share a cause with this ticket's rename fix: two near-identical builders each carried a different subset of clauses. `buildConstraintsFromColumn` and `backingColumnDef` are replaced by `columnSchemaToColumnDef` in `schema/table.ts`, which retires the "duplicated builders" gap. The two existing rename shapes were extended to cover tags and the default, so no test was added.
- **Stale comments:** in `ddl-generator.ts`, the claim that a synthesized single-column key emits no clause, and the claim that the key clause gives an all-columns key's column action somewhere to ride. Comments naming the old builder in `column.ts`, `column-rename.ts`, `store-module-alter.ts` and `materialized-view-helpers.ts` were repointed.
- **`docs/schema.md`:** the ABORT bullet is rewritten to the new rule.

**Tripwires parked**

- A rename flattens `declaredType`, marks any non-BINARY collation explicit, and resets `pkOrder` to 1. All three are read from code, not observed to matter. `NOTE:` on `columnSchemaToColumnDef`.
- `alter table … add constraint … check (…)` cannot read a `with context` variable (`Column not found`, verified on an empty table), though CREATE TABLE accepts the same CHECK. This change did not touch that path. `NOTE:` on the `addConstraint` arm in `planner/building/alter-table.ts`.

**Checked, no defect**

- All five actions on key and non-key columns, including FAIL. Inline and table-level DESC keys. The empty key with both records. A nullable inline key with an action, and last-clause-wins on the shared slot.
- Column action alongside COLLATE, DEFAULT, GENERATED and tags in one column definition; clause order re-parses.
- Action survival through ALTER COLUMN (drop not null, set default, set type, set collate), ADD COLUMN and DROP COLUMN.
- Rename of an inline key with DESC and an action, a table-level key holding both records, and a nullable column.
- `ALTER PRIMARY KEY` off an inline action and with a table-level action moving, matching the `NOTE:` on `rekeySchemaPrimaryKey`.
- Context variables: untyped, every built-in type, parameterized types (which flatten stably), mixed-case and spaced names. A bare variable stays NOT NULL under a `nullable` session default. Survives a table rename.
- Maintained tables keep an action and a table-level action through the maintained DDL form.
- `declare schema` plus `apply schema` applied twice keeps both declarations.
- `contextClauseToString`'s signature change: both callers updated. The backlog ticket `bug-rebuild-copy-refused-when-table-reads-context` and its `NOTE:` are accurate as filed; not re-run.

**Tests.** Nothing was cut: the near-duplicate composite shapes predate this change and pin different labels of the same path, and the memory and store context tests fail at different layers. No test was added, because each defect found is pinned by extending or re-pointing an existing shape. I did not separately re-run the fixed shapes against the old code; the `exp` runs above reproduced each defect before the fix.

**Major findings:** none. Nothing here needed a ticket.

**Accepted as stated by the implement stage**

- **Sync, not run for these declarations:** the sync path uses the same generator, but no test replicates a table that declares a column action or context variable.
- **Sync, mixed versions (from reading the code, not run):** `assertDefinitionMatches` compares rendered text, so a peer on the old generator and one on this generator holding such a table would report a divergence. The ABORT change above widens this to tables declaring a table-level `on conflict abort`. Backward compatibility is not a project goal yet.
- **Already-lost declarations stay lost:** text persisted before this change carries no action or context clause.
- **`on conflict rollback` behaviour is not tested across a reopen,** because it does not roll back through `db.exec` (`bug-rollback-conflict-action-not-honored`). Its survival is pinned at the schema level only.

**Validation, on the review's final code**

- `yarn workspace @quereus/quereus test`: 10883 passing, 25 pending
- `yarn test:store`: 10875 passing, 33 pending
- `yarn workspace @quereus/store test`: 1960 passing
- `yarn workspace @quereus/sync test`: 770 passing
- `yarn workspace @quereus/isolation test`: 439 passing
- `yarn workspace @quereus/quereus lint` and `yarn workspace @quereus/store typecheck`: clean

The `NOTE:` on the `addConstraint` arm was added after the engine suite and lint ran, and before `test:store`. It is a comment only.

## Tests

`table-ddl-round-trip.spec.ts`: every shape compares the raw column records and the raw table record between original and re-parsed.

| Test | Verifies |
|---|---|
| non-key columns, NOT NULL and NULL | column action rides the annotation |
| composite key, members declare different actions | both survive; no table action minted |
| composite key, ABORT then REPLACE | a column's ABORT is emitted, so the key does not flip to REPLACE |
| single-column key, table and column actions differ | each stays in its own record |
| table-level ABORT alone | emitted, stays on the table record |
| single-column key, table ABORT outranking a column action | that ABORT survives |
| descending single-column key with a table action | DESC survives on the table-level branch |
| action and tags survive RENAME COLUMN | `columnSchemaToColumnDef` |
| action, default and tags survive a source rename reaching a maintained table | `columnSchemaToColumnDef` |
| session-elided form keeps a column action | forced annotation; inline column needs none; others stay elided |
| `with context`: emitted, re-parses, byte-stable | nullable variable, reserved-word name, a DEFAULT reading a variable, followed by `with tags` |
| `with context`: re-parsed table is writable | CHECK still reads `cap`, DEFAULT still reads `n` |

`alter-table-conformance.spec.ts`: the rebuild's "differs only in the PRIMARY KEY clause" table gains a non-key `null on conflict ignore` column and a nullable context variable.

`table-declaration-reopen.spec.ts` (store, real close and `rehydrateCatalog`): `not null on conflict ignore` still skips the row; a table whose CHECK reads a variable stays writable.

## Known gaps

- **Rebuild with context variables:** `ALTER PRIMARY KEY` through the rebuild path is refused for a table whose CHECK or DEFAULT reads a context variable, because the row copy has no value to supply. Only a module with no `alterTable` reaches it. Tracked in backlog `bug-rebuild-copy-refused-when-table-reads-context`.
