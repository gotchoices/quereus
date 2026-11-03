---
description: Saving a table's definition used to lose a column's rule-violation instruction (skip the row, roll back) and the table's per-statement parameters, so reopened tables behaved differently or refused writes. Both now survive a save and reopen, and also survive renaming a column.
architecture: docs/schema.md
files:
  - packages/quereus/src/schema/ddl-generator.ts (`emittedTableKeyAction`, `onConflictClause`, `emitContextClause`, `formatColumnDef`, `nullabilityAnnotation`)
  - packages/quereus/src/emit/ast-stringify.ts (`contextClauseToString` now exported, takes the variable list)
  - packages/quereus/src/runtime/emit/alter-table.ts (`buildConstraintsFromColumn`)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts (`backingColumnDef`)
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
- **The table's action rides the table-level clause.** A single-column key renders inline only when there is no table action to emit.
- **ABORT:** a column's is always emitted. A table-level one is elided unless a key column declares an action, which it outranks.

`with context (…)` is now emitted between the `maintained as` clause and `WITH TAGS`, through the renderer the AST path uses. Column rename now keeps the action.

Text changes in persisted DDL (old text still re-parses, no migration):

- `primary key (a) on conflict replace`: `"a" … NOT NULL PRIMARY KEY ON CONFLICT REPLACE` → `"a" … NOT NULL, …, PRIMARY KEY ("a") ON CONFLICT REPLACE`
- `a … not null on conflict replace, primary key (a, b)`: `PRIMARY KEY ("a", "b") ON CONFLICT REPLACE` → `"a" INTEGER NOT NULL ON CONFLICT REPLACE, …, PRIMARY KEY ("a", "b")`

## Differences from the implement ticket

- **Extra fix, `backingColumnDef`:** it dropped the action the same way `buildConstraintsFromColumn` did, when a source column rename reshapes a maintained table's backing column. Verified lost, then fixed; it has a shape of its own.
- **`contextClauseToString` changed signature** to take the variable list, rather than delegating to a second function. Both callers updated.
- **The empty-key and composite branches merged:** both are now `if (inlinePkIndex === -1)`, since an empty list already renders `PRIMARY KEY ()`.
- **Two listed shapes not added,** because existing shapes run the same path and now get the raw-record comparison: "composite member" ('narrow composite PK, action declared on a key column') and "table-level single" ('narrow table-level PK with ON CONFLICT').
- **One shape added:** a descending single-column key with a table action, which reaches the table-level branch for the first time.
- **The reopen test is a new file,** `table-declaration-reopen.spec.ts`, since its cases are not about the primary key.

## Tests

`table-ddl-round-trip.spec.ts`: every shape now also compares the raw column records and the raw table record (ABORT normalized to absent) between original and re-parsed. Three existing `expectedText` values changed.

| New test | Verifies |
|---|---|
| non-key columns, NOT NULL and NULL | column action rides the annotation |
| composite key, members declare different actions | both survive; no table action minted |
| composite key, ABORT then REPLACE | a column's ABORT is emitted, so the key does not flip to REPLACE |
| single-column key, table and column actions differ | each stays in its own record |
| single-column key, table ABORT outranking a column action | that ABORT is not elided |
| descending single-column key with a table action | DESC survives on the table-level branch |
| action survives RENAME COLUMN | `buildConstraintsFromColumn` fix |
| action survives a source rename reaching a maintained table | `backingColumnDef` fix |
| session-elided form keeps a column action | forced annotation; inline column needs none; others stay elided |
| `with context`: emitted, re-parses, byte-stable | nullable variable, reserved-word name, a DEFAULT reading a variable, followed by `with tags` |
| `with context`: re-parsed table is writable | CHECK still reads `cap`, DEFAULT still reads `n` |

`alter-table-conformance.spec.ts`: the rebuild's "differs only in the PRIMARY KEY clause" table gains a non-key `null on conflict ignore` column and a nullable context variable.

`table-declaration-reopen.spec.ts` (store, real close and `rehydrateCatalog`): `not null on conflict ignore` still skips the row; a table whose CHECK reads a variable stays writable. Both failed against a `dist` built from the old generator and pass after a rebuild.

## Validation run

Run after the final source change, except that the `NOTE:` comment in `alter-table.ts` was added after these runs:

- `yarn workspace @quereus/quereus test`: 10883 passing, 25 pending
- `yarn test:store`: 10875 passing, 33 pending
- `yarn workspace @quereus/store test`: 1960 passing
- `yarn workspace @quereus/sync test`: 770 passing
- `yarn workspace @quereus/isolation test`: 439 passing
- `yarn workspace @quereus/quereus lint` and `yarn workspace @quereus/store typecheck`: clean

## Known gaps

- **Rebuild with context variables:** `ALTER PRIMARY KEY` through the rebuild path is refused for a table whose CHECK or DEFAULT reads a context variable, because the row copy has no value to supply. It failed before this change too, and only a module with no `alterTable` reaches it. Filed as backlog `bug-rebuild-copy-refused-when-table-reads-context`, with a `NOTE:` at the copy site. This is why the conformance test's variable is nullable and unread.
- **Already-lost declarations stay lost:** a table persisted before this change has text with no action or context clause, and nothing can recover them from it.
- **Sync, not run for these declarations:** the sync path uses the same generator, but no test here replicates a table that declares a column action or context variable.
- **Sync, mixed versions (from reading the code, not run):** `assertDefinitionMatches` in `quereus-sync/src/sync/store-adapter.ts` compares rendered text. If a peer on the old generator and one on this generator both hold such a table, it would report a divergence rather than converge. Backward compatibility is not a project goal yet, so this was left alone.
- **`on conflict rollback` behaviour is not tested across a reopen:** it does not actually roll back through `db.exec` (`bug-rollback-conflict-action-not-honored`), so the reopen tests use IGNORE. ROLLBACK's survival is pinned at the schema level only.
- **Duplicated builders:** `buildConstraintsFromColumn` and `backingColumnDef` both rebuild a column definition from a `ColumnSchema`, and both had this bug. They were left separate because they carry different subsets of clauses.
