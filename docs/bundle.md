# Bundle Files

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

A **bundle** is one YAML file, conventionally `bundle.yaml`, that carries one or more schemas of a Quereus database and the rows of their tables. The schema travels as `declare schema` text, which an importer applies with `apply schema`; the rows travel in batches, encoded so every `SqlValue` reads back with the same value and the same JavaScript type. `@quereus/bundle` (`packages/quereus-bundle`) defines the format and writes it. This document is the authoritative description of the format; the package [README](../packages/quereus-bundle/README.md) has usage examples.

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

Not implemented yet: `@quereus/bundle` currently writes bundles and does not read them.

### Rejected alternatives

- **One YAML document for the whole file.** The reader would parse everything into memory before applying anything, and one corrupt byte would lose the file.
- **Rows as maps keyed by column name.** Repeating every column name on every row multiplies the file size; the header states the column order once.
- **The `yaml` library's own `!!binary`.** It encodes a typed array's whole backing buffer rather than its view, reads into a Node `Buffer`, and accepts malformed base64 silently. The package registers its own tag.
- **Reading ints as JavaScript numbers.** An integer past 2^53−1 loses precision before the codec sees it.
