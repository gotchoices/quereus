# Bundle Files

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

A **bundle** is one YAML file, conventionally `bundle.yaml`, that carries one or more schemas of a Quereus database and the rows of their tables. The schema travels as `declare schema` text, which an importer applies with `apply schema`; the rows travel in batches, encoded so every `SqlValue` reads back with the same value and the same JavaScript type. `@quereus/bundle` (`packages/quereus-bundle`) defines the format, writes it and reads it. This document is the authoritative description of the format; the package [README](../packages/quereus-bundle/README.md) has usage examples.

## Format (version 1)

A bundle is a multi-document YAML 1.2 stream: one **header** document, zero or more **data** documents, and one **trailer** document, separated by `---` lines.

```yaml
quereus-bundle: 1
created: 2026-11-16T12:00:00.000Z
schemas:
  - name: main
    declaration: |-
      declare schema main { table users (id INTEGER not null primary key, email TEXT null collate binary, avatar BLOB null); view active as select id from users where email is not null; }
tables:
  - schema: main
    table: users
    columns: [id, email, avatar]
---
data: {schema: main, table: users}
rows:
  - [1, a@example.com, !!binary AAEC]
  - [2, "true", null]
---
data: {schema: main, table: users}
rows:
  - [3, null, null]
---
end:
  tables:
    - {schema: main, table: users, rows: 3}
```

**Header.**

- `quereus-bundle` is the integer format version. A reader refuses a version it does not know.
- `created` is the ISO 8601 time the export started.
- `schemas` is present when the schema was exported. Each entry holds exactly one `declare schema <name> { … }` statement, written by `exportSchemaDeclaration` (see [Declarative Schema § Exporting a declaration](schema-declarative.md#exporting-a-declaration)) and emitted as a literal block scalar. It pins every column's nullability and collation, so the importing session's defaults do not change them.
- `tables` is present when data was exported. It lists every table whose rows follow, in the order their data documents appear, with its column list once. `schema` and `table` are separate fields because names may contain dots.

**Data documents.** Each names its table under `data` and carries `rows`: one flow sequence per row, on one line, positional against that table's `columns`. Each data document is one batch. A table's rows may span many data documents, and the documents for one table are contiguous. An empty table is listed in `tables` and has no data document.

**Trailer.** `end.tables` lists, per exported table, the number of rows its data documents carry. An entry also carries `error: <message>` when the export gave up on that table partway (see [Errors](#errors)); its rows are then incomplete. A bundle without a trailer is truncated.

A reader parses one document at a time, so memory stays bounded by the batch size, each batch can be applied in its own transaction, and a corrupt document costs one batch rather than the file.

## Value encoding

The engine's numeric rule R1 ([Type System § Physical representation](types.md#physical-representation): a value is a `bigint` only outside the safe-integer range) is what lets the codec tell integers and floats apart on the way back.

| SqlValue | Written as | Reads back as |
|---|---|---|
| `null` | `null` | `null` |
| `boolean` | `true` / `false` | `boolean` |
| `number`, a safe integer other than `-0` | int (`42`) | `number` |
| any other `number`: a fraction, `-0`, a whole number past 2^53−1, NaN, ±Infinity | a float that cannot read as an int (`0.5`, `-0.0`, `1e+20`, `.nan`, `.inf`, `-.inf`) | the identical `number` (`Object.is`) |
| `bigint` | int (`-9223372036854775808`) | `bigint` |
| `string` | plain, or quoted where plain would read as another type (`"true"`, `"1"`, `"null"`, `""`) | `string` |
| `Uint8Array` | `!!binary` base64 | a plain `Uint8Array` |
| JSON object / array | nested flow map / flow sequence | a plain object / array with JSON semantics: numbers are `number`, keys are strings |

- Ints are read as `bigint` and narrowed with `canonicalizeSqlValue`, the only way a large integer survives a YAML read without precision loss.
- A string holding a line break (`\n`, `\r`, and the YAML 1.1 breaks U+0085, U+2028, U+2029) is written double-quoted with escapes, so a row never spans lines. Unpaired UTF-16 surrogates are written as `\u` escapes, because written raw they would be invalid UTF-8.
- A top-level SQL `null` cell is SQL NULL; a `null` inside a JSON value stays JSON `null`.
- Values with no lossless encoding are refused, never coerced: a `Date`, a `Map`, a class instance, or a JSON-shaped value holding anything but JSON (a `bigint`, `undefined`, a `Uint8Array`).
- On read, a bundle may not hold an alias, a tag other than the core ones and `!!binary` (so `!!timestamp`, `!!set` and local tags are refused), malformed base64, or a map key that is not a scalar. Bundles are often untrusted input; refusing aliases also closes alias-expansion attacks.

## Export

```ts
import { exportBundle } from '@quereus/bundle';

for await (const chunk of exportBundle(db, { schemas: ['main'], batchSize: 1000 })) {
	write(chunk);
}
```

`exportBundle(db, options?)` returns an `AsyncIterable<string>`, one YAML document per string, and reads nothing until the first string is requested. The caller decides where the text goes; the package uses no platform API.

| Option | Default | Meaning |
|---|---|---|
| `schemas` | `['main']` | Schemas to export, in this order |
| `schema` | `true` | Include each schema's declaration |
| `data` | `true` | Include table rows |
| `tables(schema, table)` | all | Which tables' rows to include |
| `batchSize` | `1000` | Rows per data document |
| `errorPolicy` | `'abort'` | `'abort'` or `'skip-table'`; see [Errors](#errors) |
| `onProgress`, `onError`, `signal` | | Hooks; see [Progress, errors and cancelling](#progress-errors-and-cancelling) |

**Which tables, which columns, in what order.** Only tables that hold their own rows are exported: views have none, a maintained table's rows are derived and `apply schema` refills them, and engine-managed tables (tagged `ENGINE_MANAGED_TABLE_TAG`) are not part of the schema. Columns are the non-generated columns in declaration order, since a generated column cannot be inserted. Within a schema, tables are sorted by name, as the declaration lists them, then reordered parents-first along same-schema foreign keys with `orderDependenciesFirst`; tables in a cycle keep their sorted order. Loading parents first keeps an importer's intermediate states coherent and makes cross-table CHECKs and assertions judged at each batch commit less likely to fail.

**Consistent read.** When the database is in autocommit, the export runs `begin` before its first row read and ends that transaction when iteration ends: it commits after a finished or abandoned export (a `for await` that `break`s calls the generator's `return`, which runs the cleanup) and rolls back after a failure. Inside a caller's transaction, the export reads within it and leaves it open. A table's rows stream through one statement, which holds the database's execution lock while the consumer handles each string. **Do not run statements on the same database while consuming an export**: they would wait for the export, which waits for the consumer. A consumer that stops calling `next()` without finishing or calling `return()` leaves the transaction open.

**Declarations** are resolved before any text is yielded. A schema that is missing, is a logical schema, or cannot be exported is a `schema` error, thrown from the first `next()`.

### Progress, errors and cancelling

The hooks are shared with import. `onProgress` receives a `BundleProgress` (`phase`, `schema`, `table`, `tableIndex` / `tableCount`, `rowsDone` within the table, `totalRowsDone` across the run, `batchIndex`). The export reports phase `schema` once per exported declaration, and phase `data` when a table starts and after each data document.

Every problem is a `BundleError` carrying `phase`, `kind`, the schema and table, a `rowIndex` where one applies, and the underlying error as `cause`. Each goes to `onError` as it happens. A hook that throws is logged and the run continues; hooks observe, they do not steer, except that `onError` returning `'abort'` stops the run whatever the error policy. `signal` is checked before each table and after each data document; when aborted, the export throws a `cancelled` error.

### Errors

A table whose read fails (kind `batch`) or holds a value with no encoding (kind `value`, naming the column and row) ends that table:

- `errorPolicy: 'abort'` throws the error. The text yielded so far has no trailer, so a reader sees it as truncated.
- `errorPolicy: 'skip-table'` reports it, writes the rows read before the failure, records the row count and `error` in the table's trailer entry, and moves on to the next table.

Invalid options (`batchSize` below 1, neither `schema` nor `data`, an empty `schemas` list, a schema listed twice) throw `MisuseError` when `exportBundle` is called.

## Import

```ts
import { createReadStream } from 'node:fs';
import { importBundle } from '@quereus/bundle';

const report = await importBundle(db, createReadStream('bundle.yaml', 'utf8'), { errorPolicy: 'skip-row' });
if (!report.ok) for (const error of report.errors) console.warn(error.kind, error.message);
```

`importBundle(db, source, options?)` reads `source` one YAML document at a time and resolves to an `ImportReport`. `source` is the whole text, or its chunks in order as an `Iterable<string>` or `AsyncIterable<string>`; a Node `fs.createReadStream(path, 'utf8')` and a browser `ReadableStream` piped through `TextDecoderStream` are both the latter. A chunk may end anywhere, even inside a line. Memory stays bounded by the largest document, not the file.

| Option | Default | Meaning |
|---|---|---|
| `schema` | `'apply'` | `'apply'` migrates each schema to the header's declaration; `'verify'` fails when the database differs from it; `'skip'` ignores it |
| `allowDestructive` | `false` | Let `'apply'` run a plan with destructive statements (see [Schema phase](#schema-phase)) |
| `renamePolicy` | the engine's (`'allow'`) | Passed to `apply schema … options (rename_policy = …)` |
| `confirmSchemaPlan(plan)` | | Asked with the `SchemaPlan` (`schema`, `ddl`, `destructive`) before a non-empty plan runs; `false` stops the import |
| `tables(schema, table)` | all | Which tables' rows to load. A table it rejects is left out of the report and the trailer check |
| `onConflict` | `'abort'` | What a row whose key already exists does: `'abort'` fails it, `'skip'` keeps the stored row, `'update'` overwrites the stored row's non-key columns |
| `errorPolicy` | `'abort'` | What a failed batch does: `'abort'`, `'skip-batch'` or `'skip-row'`; see [Data phase](#data-phase) |
| `onProgress`, `onError`, `signal` | | Hooks; see [Progress, errors and cancelling](#progress-errors-and-cancelling) |

**Throw or report.** `importBundle` throws `MisuseError` only for misuse: an invalid option, a database inside a transaction (the import runs its own transactions, so it refuses rather than commit the caller's work), or a source that yields something other than strings. Every problem with the bundle's content, or with applying it, is a `BundleError`, delivered to `onError` as it happens and listed in `report.errors`, and the promise resolves.

**The report.** `ok` is true when no error was recorded and the run was not cancelled. `schemas` lists, per declaration handled, the DDL `apply schema` ran. `tables` lists, per manifest table the `tables` filter accepts: `rowsRead` (rows its data documents carry), `rowsApplied` (rows committed, including rows `onConflict: 'skip'` left as they were), `rowsFailed` (rows not applied because of an error), `batchesFailed` (documents that failed as a whole) and `expectedRows` (the trailer's count, once read).

**Not all-or-nothing.** Each data document is its own transaction. A failure never takes back a document already committed: `rowsApplied` says what stayed. Do not run statements on the same database while an import runs: they would interleave between batches, and with `foreign_keys` off for the whole database.

### Schema phase

For each `schemas` entry, unless `schema: 'skip'`:

1. **The declaration must be exactly one `declare schema` statement for the schema the entry names**, and not a logical schema. A bundle is untrusted input and its declaration runs as SQL; anything else is a fatal `schema` error, so a crafted file cannot run other statements. The guard limits the kind of statement, not what it declares: a declared table may name any virtual-table module the application has registered, with any module arguments (`table t (…) using <module>(…)`). To import a bundle from an untrusted source, review `plan.ddl` in `confirmSchemaPlan`, or use `schema: 'skip'` against a schema the application declared itself.
2. The import runs the declaration, collects the plan with `diff schema`, and afterwards puts the database's own declaration of that schema (and its seed rows) back, or removes the import's when there was none. An import does not replace the application's declared state.
3. **Destructive statements** are any drop (including the drop half of a view or index recreate), and an `alter table` that drops a column or constraint or changes a column's type: the statements that lose data or break dependents. Under `renamePolicy: 'deny'` the engine turns every rename the plan shows into a drop and a create, so renames count too (`diff schema` always plans as `'allow'`).
4. `'verify'`: a non-empty plan is a fatal `schema` error listing it. `'apply'`: a plan with destructive statements is a fatal `destructive` error listing them unless `allowDestructive` is set, and nothing has run; then `confirmSchemaPlan` is asked (a hook that throws counts as declining), and `apply schema` runs. A refused `apply schema` is fatal, with the engine's error as `cause`. It leaves the catalog as it was, except after a destructive step has run: see [Declarative Schema § Failure and restoration](schema-declarative.md#failure-and-restoration).

`onProgress` reports phase `schema` once per schema.

### Data phase

**Foreign keys are off while rows load**, and restored afterwards on every exit path. Documents commit one by one and the engine judges a child's foreign key at commit, so a child row whose parent arrives in a later document (a self-referencing table, a cycle between tables) would fail although the bundle is consistent. Dump tools do the same; [verification](#verification) checks afterwards.

For each data document:

- The table must be in the header's `tables` manifest. The target table must exist, hold its own rows (not a maintained table), and have every manifest column, none of them generated; a target column the bundle does not carry takes its default. A table that fails these checks is reported once, and its documents are skipped.
- Rows are inserted with one prepared statement per table. `onConflict: 'skip'` adds `on conflict do nothing`; `'update'` adds `on conflict (<primary key>) do update set c = excluded.c` for each non-key manifest column, and behaves as `'skip'` for a table with none. Not `insert or replace`, which deletes and re-inserts and so fires `on delete` cascades.
- The document runs as one transaction. A row of the wrong arity, or with a value no bundle holds, is a failure like a statement error. On any failure the transaction rolls back, then:
  - `'abort'`: a `batch` error naming the failing row, and the import stops.
  - `'skip-batch'`: a `batch` error, and the import moves to the next document.
  - `'skip-row'`: the document's rows are replayed one transaction each, and each failing row is a `row` error carrying its document index, row index, line and cause.
- A document that is not valid YAML, or not shaped like a data document, costs its batch: a `format` error with its line and column, handled like a failed batch under the error policy. A syntax error that breaks the stream's document structure shows up as such errors followed by `truncated` or `count-mismatch`.
- A failed rollback after a failure is a `batch` error with the original error as `cause`, and the import stops, since the transaction state is no longer known.

`onProgress` reports phase `data` after each document. `signal` is checked between documents: when aborted the import stops, records a `cancelled` error and sets `report.cancelled`. `onError` returning `'abort'` stops after the current document, or under `'skip-row'` before the document's next row.

**The trailer.** Each table's trailer count is compared with the rows its documents carried (read, not applied: rows that failed are already reported); a difference is a `count-mismatch` error. A trailer entry with `error` (the export gave up on that table) is a `truncated` error naming the table. A table missing from the trailer, or a trailer entry for a table the manifest does not list, is a `format` error. A bundle that ends without a trailer is `truncated`, and a document after the trailer is a `format` error.

### Verification

When `foreign_keys` was on before the import, then once it is back on, every foreign key whose child **or** parent table received rows is checked with the engine's existing-row scan. The parent matters too: `onConflict: 'update'` can change a parent's unique non-key column and orphan rows in a table the bundle never touched. Each violation is a `foreign-key` error naming the child table and the constraint. Nothing is rolled back: the rows stay committed. Verification is skipped when the run was cancelled or `onError` answered `'abort'`, and `onProgress` reports phase `verify` per foreign key checked.

**Fix a reported violation before relying on queries over that foreign key.** The optimizer treats a declared foreign key as holding, so while orphaned rows exist a query whose answer depends on them (`not exists (select … from parent …)`, or a join it can prove redundant) can leave them out.

### Known limits

- **Cross-table CHECKs and assertions are judged at each document's commit**: they are deferred to commit, and `foreign_keys` does not cover them. A bundle whose rows satisfy them only once every table has loaded fails document by document. The exporter's parents-first order makes this rarer.
- **Maintained tables and materialized views** carry no data documents: `apply schema` creates them, and the rows loaded into their sources afterwards flow through normal maintenance.
- **Importing the same bundle twice** fails on the first document under the default `onConflict: 'abort'`, and changes nothing under `'skip'`.

## Rejected alternatives

- **One YAML document for the whole file.** The reader would parse everything into memory before applying anything, and one corrupt byte would lose the file.
- **Rows as maps keyed by column name.** Repeating every column name on every row multiplies the file size; the header states the column order once.
- **The `yaml` library's own `!!binary`.** It encodes a typed array's whole backing buffer rather than its view, reads into a Node `Buffer`, and accepts malformed base64 silently. The package registers its own tag.
- **Reading ints as JavaScript numbers.** An integer past 2^53−1 loses precision before the codec sees it.
- **One transaction for the whole import.** A large bundle would hold every row in one transaction, and one bad row anywhere would lose the file. Per-document transactions keep each failure to its batch.
- **Keeping foreign keys on and ordering rows parents-first.** Parents-first order cannot help a self-referencing table or a cycle between tables, and documents commit separately.
- **`insert or replace` for `onConflict: 'update'`.** It deletes the stored row and inserts the new one, which fires `on delete` cascades and actions; `on conflict … do update` changes the row in place.
