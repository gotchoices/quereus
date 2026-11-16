description: Create a new package that saves a database's schema and/or data into a single compact `bundle.yaml` file, in batches, reporting progress and errors as it goes.
prereq: schema-export-declaration
architecture: docs/bundle.md
files: packages/quereus-bundle/ (new: package.json, tsconfig.json, tsconfig.test.json, register.mjs, README.md, src/index.ts, src/format.ts, src/value-codec.ts, src/hooks.ts, src/export.ts, test/value-codec.spec.ts, test/export.spec.ts), tsconfig.build.json, package.json (root build:/pub: scripts), AGENTS.md (project structure), docs/bundle.md (new), docs/.stability.json, packages/quereus/README.md (docs index), packages/quereus/src/util/numeric-canonical.ts (read only)
----
## What this is

`@quereus/bundle` (directory `packages/quereus-bundle`) defines the **bundle** file format: a YAML file that carries one or more schemas, as `declare schema` text that import runs through `apply schema`, plus table data serialized compactly. This ticket builds the package skeleton, the format definition, the value codec, and **export**. Import is `bundle-import`. Both sides share the format types, codec and hook types defined here.

Package layout follows `packages/quereus-isolation` (Mocha + ts-node via `register.mjs`, `tsconfig.json` referencing `../quereus`, a `tsconfig.test.json` that repeats `"exclude": ["node_modules", "dist"]`, a `lint` script echoing `'No lint configured'`, and a `typecheck` that covers tests). Register the package in `tsconfig.build.json` references and add `build:bundle` / `pub:bundle` root scripts (check `scripts/publish-package.js` for a package list). Dependencies: `@quereus/quereus` (peer + workspace) and `yaml@^2.9.0` (already resolved in `yarn.lock`). The package is cross-platform: no `fs`, no Node-only APIs in `src/`. Output is `AsyncIterable<string>`, and the caller decides where it goes.

## Format (version 1)

A bundle is a **multi-document YAML 1.2 stream**: one header document, zero or more data documents, one trailer document. Each data document is one batch. That gives the importer bounded memory (it parses one document at a time), a transaction per batch, and a natural unit of error isolation (a corrupt document costs one batch, not the file).

```yaml
quereus-bundle: 1
created: 2026-11-16T12:00:00.000Z
schemas:
  - name: main
    declaration: |
      declare schema main {
        table users (id integer primary key, email text not null, avatar blob)
        view active as select id from users where email is not null
      }
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
end:
  tables:
    - {schema: main, table: users, rows: 2}
```

- `quereus-bundle` is the integer format version. An importer refuses a version it does not know.
- `schemas` is present when the schema was exported. Each entry holds exactly one `declare schema <name> { … }` statement (`astToString(exportSchemaDeclaration(db, name))`), emitted as a literal block scalar.
- `tables` is present when data was exported. It lists every table whose rows follow, with the **column list once**, so data rows are positional arrays and do not repeat keys. `schema` and `table` are separate fields because names may contain dots.
- A data document names its table and carries `rows`: each row is a flow sequence on one line, positional against that table's `columns`. A table's rows may span many data documents. Documents for one table are contiguous.
- The trailer lists, per exported table, the number of rows written. On an export-side skip it also carries `error: <message>` (see below). A missing trailer means the file is truncated.

Write the authoritative format spec in a new `docs/bundle.md`: this section plus the value encoding below, an export API section, and an import section stub that `bundle-import` fills. Follow `docs/doc-conventions.md` (stability banner, word cap; mark it Experimental), register it in `docs/.stability.json`, link it from the `packages/quereus/README.md` docs index, and run `yarn docs:check`.

## Value codec (`src/value-codec.ts`)

`encodeValue(v: SqlValue): yaml Node` and `decodeValue(node, …): SqlValue`, with the engine's numeric rule R1 (`docs/types.md` § Physical representation: a value is a `bigint` only outside the safe-integer range) as the contract:

| SqlValue | YAML | decodes to |
|---|---|---|
| `null` | `null` | `null` |
| `boolean` | `true` / `false` | `boolean` |
| `number`, safe integer, not `-0` | int literal (`42`) | `number` |
| `number`, anything else (fraction, `-0`, magnitude > 2^53−1, NaN, ±Infinity) | float literal that is guaranteed to read back as float (`-0.0`, `1.0e+20`, `.nan`, `.inf`, `-.inf`) | `number`, `Object.is`-identical |
| `bigint` (always outside the safe range, by R1) | int literal | `bigint` |
| `string` | plain or quoted scalar as `yaml` chooses (it quotes `"true"`, `"1"`, `"null"`, `""`, …) | `string` |
| `Uint8Array` | `!!binary` base64 | plain `Uint8Array` (normalize a Node `Buffer`) |
| JSON object / array | nested flow map / flow sequence | plain object / array whose nested numbers are JS `number` (as `JSON.parse` would give) |

Reading parses ints with `intAsBigInt: true` and runs them through the engine's `canonicalizeSqlValue` (exported from `@quereus/quereus`). That is the only way a large integer survives YAML without precision loss. Writer options: `version: '1.2'`, `lineWidth: 0` (never fold long strings), `customTags: ['binary']`, `blockQuote: 'literal'`. Reader options: `maxAliasCount: 0` (a bundle never contains anchors or aliases, and refusing them closes alias-expansion attacks from untrusted files), `uniqueKeys: true`.

Values the codec cannot encode (a `Date`, `Map`, class instance, or a custom OBJECT-physical value that is not plain JSON) are an export error naming schema, table, column and row, never a lossy coercion.

## Hooks and errors (`src/hooks.ts`)

Shared by export and import:

```ts
export type BundlePhase = 'read' | 'schema' | 'data' | 'verify';
export interface BundleProgress {
	phase: BundlePhase;
	schema?: string; table?: string;
	tableIndex?: number; tableCount?: number;
	rowsDone: number;          // within the current table
	totalRowsDone: number;     // across the whole run
	batchIndex?: number;
}
export class BundleError extends Error {   // structured, carries `cause`
	phase: BundlePhase;
	kind: 'format' | 'version' | 'value' | 'schema' | 'destructive' | 'row' | 'batch' | 'foreign-key' | 'count-mismatch' | 'truncated' | 'cancelled';
	schema?: string; table?: string;
	documentIndex?: number; rowIndex?: number; line?: number; column?: number;
}
export interface BundleHooks {
	onProgress?(p: BundleProgress): void;
	onError?(e: BundleError): void | 'abort';   // 'abort' stops early regardless of policy
	signal?: AbortSignal;                       // checked between batches
}
```

A throwing hook is logged and does not break the run. Hooks are observers. Cancelling goes through `signal` or `onError` returning `'abort'`.

## Export (`src/export.ts`)

```ts
export interface ExportOptions extends BundleHooks {
	schemas?: string[];                 // default ['main']
	schema?: boolean;                   // include declarations, default true
	data?: boolean;                     // include rows, default true
	tables?: (schema: string, table: string) => boolean;
	batchSize?: number;                 // rows per data document, default 1000
	errorPolicy?: 'abort' | 'skip-table';   // default 'abort'
}
export function exportBundle(db: Database, options?: ExportOptions): AsyncIterable<string>;
```

1. Validate options (`batchSize` ≥ 1, at least one of `schema` / `data`). Resolve declarations. A declaration failure is fatal (thrown `BundleError`, phase `schema`) before any text is yielded.
2. Build the table manifest per schema: physical tables only. Skip views, maintained tables (their rows are derived; `apply schema` refills them), and tables tagged `ENGINE_MANAGED_TABLE_TAG = true`. Apply the `tables` filter. Columns are the non-generated columns in declaration order (a generated column cannot be inserted). Order tables parents-first along same-schema foreign keys with `orderDependenciesFirst` (cycles keep declaration order). That keeps the importer's intermediate states coherent and makes batch-commit-time cross-table CHECKs and assertions less likely to trip.
3. Yield the header document.
4. **Consistent read:** if `db.getAutocommit()`, run `begin` before the first data read and close the transaction in a `finally`. That `finally` covers a consumer that stops iterating early (`break` calls the generator's `return`). Inside a caller-held transaction, read within it and leave it alone. Document that the caller must not write to the same database while an export is being iterated.
5. Per table: stream `select "c1", … from "schema"."table"` via `db.eval`. Every `batchSize` rows, yield one data document (built as a yaml `Document` whose rows are flow sequences) and fire `onProgress`. Check `signal` between batches.
6. A table read that fails: under `abort`, throw a `BundleError` (phase `data`, kind `batch`) with the cause. Under `skip-table`, report via `onError`, keep the documents already yielded, and record `error` plus the rows actually written in that table's trailer entry, so the importer knows the table is incomplete.
7. Yield the trailer.

## Edge cases & interactions

- **Strings that look like other scalars** (`"true"`, `"1"`, `"~"`, `""`, `".nan"`, leading/trailing spaces, `#`, newlines, tabs, a lone UTF-16 surrogate, emoji). A lone surrogate must not be written raw, because it becomes invalid UTF-8 on disk. If `yaml` does not escape it, the codec must force a double-quoted scalar with `\u` escapes. Verified by the codec test.
- **`-0`, `1e20`, NaN, ±Infinity, `Number.MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER + 1` as bigint, −2^63.** Verified by the codec test, including `typeof` and `Object.is`.
- **JSON values with nested large integers or non-string keys:** decoded into JSON semantics (numbers, string keys). JSON `null` inside an object stays JSON `null`. A top-level SQL `null` cell is SQL NULL (the engine draws no other distinction). Verified by the codec test.
- **Empty table:** listed in `tables` with `rows: 0` in the trailer and no data document. **Empty schema:** a declaration with no items. Verified by inspection.
- **Consumer abandons the iterator mid-export:** the transaction the export opened is closed and the database is back in autocommit. Verified by the export test.
- **Schema-only / data-only exports:** the header omits `tables` / `schemas` respectively. Verified by inspection.
- **Table names needing quotes** in the select are quoted with the engine's `quoteIdentifier`. Verified by inspection.

## Tests

- `test/value-codec.spec.ts`: one round-trip test over the value table above (each row of the table plus the edge values). It asserts `sqlValueIdentical(decode(encode(v)), v)`, the same `typeof`, and `Object.is` for `-0` and NaN.
- `test/export.spec.ts`: (a) a golden test: a small two-table database with `batchSize: 2` exports to an exact expected text, which pins the format; (b) breaking out of the iterator after the first chunk leaves `db.getAutocommit() === true`.

## TODO

- Scaffold `packages/quereus-bundle` (package.json, tsconfigs, register.mjs, README), wire `tsconfig.build.json`, root scripts, AGENTS.md project structure.
- `format.ts`: header / data / trailer types and the version constant.
- `value-codec.ts` per the table, with yaml read and write option constants shared with import.
- `hooks.ts`: progress / error types, safe hook invocation.
- `export.ts`: `exportBundle`.
- Tests above.
- `docs/bundle.md` (format, codec, export), `.stability.json`, README docs index, `yarn docs:check`.
- `yarn build`, `yarn typecheck`, `yarn test`.
