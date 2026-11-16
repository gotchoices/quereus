description: Load a `bundle.yaml` file into a database: apply its schema safely, insert its data in batches, keep going past bad rows or batches when asked to, and report progress and every problem it hits.
prereq: bundle-package-format-and-export
architecture: docs/bundle.md
files: packages/quereus-bundle/src/import.ts (new), packages/quereus-bundle/src/read-documents.ts (new), packages/quereus-bundle/src/index.ts, packages/quereus-bundle/src/format.ts, packages/quereus-bundle/src/value-codec.ts, packages/quereus-bundle/src/hooks.ts, packages/quereus-bundle/test/import.spec.ts (new), packages/quereus-bundle/README.md, docs/bundle.md, packages/quereus/src/schema/constraint-builder.ts (read only: validateForeignKeyOverExistingRows)
----
## What this is

The import half of `@quereus/bundle`. Format, codec and hook types come from `bundle-package-format-and-export`; read `docs/bundle.md` first. This ticket adds:

```ts
export interface ImportOptions extends BundleHooks {
	schema?: 'apply' | 'verify' | 'skip';        // default 'apply'
	allowDestructive?: boolean;                   // default false
	renamePolicy?: 'allow' | 'require-hint' | 'deny';
	confirmSchemaPlan?(plan: SchemaPlan): boolean | Promise<boolean>;
	tables?: (schema: string, table: string) => boolean;
	onConflict?: 'abort' | 'skip' | 'update';     // default 'abort'
	errorPolicy?: 'abort' | 'skip-batch' | 'skip-row';  // default 'abort'
}
export interface SchemaPlan { schema: string; ddl: string[]; destructive: string[]; }
export interface ImportReport {
	ok: boolean;                       // true when no errors were recorded and the run was not cancelled
	cancelled: boolean;
	schemas: Array<{ schema: string; ddlApplied: string[] }>;
	tables: Array<{ schema: string; table: string; rowsRead: number; rowsApplied: number; rowsFailed: number; batchesFailed: number; expectedRows?: number }>;
	errors: BundleError[];
}
export function importBundle(db: Database, source: string | Iterable<string> | AsyncIterable<string>, options?: ImportOptions): Promise<ImportReport>;
```

A Node `fs.createReadStream(path, 'utf8')` and a browser `ReadableStream` piped through `TextDecoderStream` are both `AsyncIterable<string>`, so no platform helper is needed.

**Throw vs report.** `importBundle` throws only on caller misuse: invalid options, or `!db.getAutocommit()` (the import manages its own transactions, so refuse up front rather than commit the caller's work). Every problem with the bundle's content or with applying it is a `BundleError`. It is delivered to `onError` as it happens and recorded in the report, and the promise resolves.

## Reading (`src/read-documents.ts`)

An async generator that yields one parsed document at a time from chunked input: yaml's incremental `Parser.parse(chunk, /*incomplete*/ true)` feeding a `Composer`, with a `LineCounter` so errors carry line and column, and `parse('', false)` plus `composer.end()` at EOF. Use the same reader options as the codec (`maxAliasCount: 0`, `uniqueKeys: true`). A document with YAML errors is yielded with its errors (document index, first error's line and column) so the caller can apply the error policy to that batch. Do not split the text on `---` by hand.

## Flow

1. **Header.** The first document must be a header with `quereus-bundle: 1`. Anything else (empty input, a data document first, an unknown version, a malformed header) is a fatal `format` / `version` error: report and stop.
2. **Schema phase** (per header `schemas` entry, unless `schema: 'skip'`).
   - **Guard the declaration text.** Parse it with the engine `Parser`. It must be exactly one `declareSchema` statement whose `schemaName` equals the entry's `name`; otherwise it is a fatal `schema` error. A bundle is untrusted input, and this is what stops a crafted file from running arbitrary SQL.
   - Save the database's existing declaration for that schema (`db.declaredSchemaManager.getDeclaredSchema`). Then `declare schema` with the text, collect the plan with `diff schema <name>` (each result row's `ddl`), and in a `finally` restore the saved declaration (`setDeclaredSchema`), or `removeDeclaredSchema` if there was none. An import must not silently replace the application's own declared state.
   - **Destructive classification:** parse each planned DDL statement and mark it destructive when it is a drop (table, view, index, assertion) or an `alter table` that drops a column or constraint or changes a column's data type. Those are the statements that lose data or break dependents (cf. the irreversible steps in `docs/schema-declarative.md` § Failure and restoration).
   - `'verify'`: a non-empty plan is a fatal `schema` error listing the DDL.
   - `'apply'`: if any statement is destructive and `!allowDestructive`, it is a fatal `destructive` error listing them, and nothing has run. Otherwise call `confirmSchemaPlan` when given; `false` is fatal. Then `apply schema <name>`, adding `options (allow_destructive = true, rename_policy = '…')` when set. `apply schema` is all-or-nothing, so a failure here leaves the catalog unchanged: report it as fatal with the engine error as `cause`.
   - Fire `onProgress` (phase `schema`) per schema.
3. **Data phase.**
   - Read the current `foreign_keys` setting (`db.options`) and switch it off for the load. Restore it in a `finally`. Batches commit independently, and the engine judges child foreign keys at commit, so a child row whose parent sits in a later batch (a self-referencing table, a cycle) would otherwise fail although the bundle is consistent. This is what dump tools do; step 5 verifies afterwards.
   - Per data document: validate the shape (`data.schema`, `data.table`, `rows` sequence). The table must be in the header's `tables` manifest; skip it if the `tables` filter rejects it. The target table must exist and have every manifest column, none of them generated. A table failing those checks is reported once, and its documents are skipped.
   - Prepare and cache one statement per table: `insert into "s"."t" ("c1", …) values (?, …)` plus the conflict clause. `'skip'` uses `on conflict do nothing`. `'update'` uses `on conflict (<pk cols>) do update set c = excluded.c` for every non-key manifest column. Do not use `insert or replace`: it deletes and re-inserts, which fires `on delete` cascades (the same reasoning as the seed rules in `docs/schema-declarative.md` § Seed Data). A table with no non-key columns under `'update'` behaves as `'skip'`. Finalize the statements in a `finally`.
   - Run each document as one transaction: `begin`, decode each row (wrong arity or an undecodable value is a `row` error), `run`, `commit`. On any failure, `rollback`, then:
     - `abort`: record the error and stop. Earlier batches stay committed; the report says so through `rowsApplied`.
     - `skip-batch`: record a `batch` error and continue with the next document.
     - `skip-row`: re-run that document's rows one transaction per row, record a `row` error (document index, row index, cause) for each failure, and keep the rest.
   - `onError` returning `'abort'` stops after the current batch. `signal` is checked between batches (`cancelled: true`, and a `cancelled` error is recorded).
   - `onProgress` (phase `data`) fires after each batch.
4. **Trailer.** Compare each table's trailer `rows` with the rows read (not applied: skipped rows are already reported). A mismatch is a `count-mismatch` error. A trailer entry with `error` (the export skipped part of that table) is recorded as an error naming the table. No trailer at EOF is a `truncated` error. A document after the trailer is a `format` error.
5. **Verify phase.** If `foreign_keys` was on before the import, then once it is restored, run the engine's `validateForeignKeyOverExistingRows(db, childTable, fk)` (public) for every foreign key whose child **or** parent table received rows. An `'update'` can change a parent's unique non-key column and orphan rows in a table the bundle never touched. Each failure is a `foreign-key` error naming the child table and the constraint. Nothing is rolled back; the data is committed and the report states the violation. Fire `onProgress` (phase `verify`).

## Edge cases & interactions

- **Cross-table CHECKs and assertions are judged at each batch commit** (they are auto-deferred to commit, not covered by `foreign_keys`). A bundle whose rows satisfy them only after every table has loaded fails batch by batch. The exporter's parents-first order makes this rarer. Document it as a known limit in `docs/bundle.md`. Verified by inspection.
- **Maintained tables / materialized views** are refilled by `apply schema` and carry no data documents. Rows imported into their source tables in later batches flow through normal maintenance. Verified by the round-trip test.
- **Data-only bundle into an existing schema** (`schemas` absent): the schema phase is a no-op and the column checks in step 3 guard the load. Extra target columns take their defaults. Verified by inspection.
- **Same bundle imported twice:** with `onConflict: 'abort'` the second run fails on the first batch, reported. With `'skip'` it is a no-op. Verified by inspection.
- **A YAML syntax error inside one data document** costs that batch only (under `skip-batch` / `skip-row`), with line numbers. A syntax error that corrupts the stream's document structure surfaces as the reader's errors and then `truncated` or `count-mismatch`. Verified by test.
- **Hook throws** are logged and swallowed (see hooks in `bundle-package-format-and-export`). **Rollback failure** after a failed batch is recorded with the original error as `cause`, and the import stops: the transaction state is no longer known. Verified by inspection.
- **`pragma foreign_keys`, the restored declaration and finalized statements** are restored on every exit path, including a thrown hook, a cancelled signal and a fatal error. Verified by inspection.

## Tests (`test/import.spec.ts`; each pins a branch)

- **Round trip:** source database with foreign keys (including a self-referencing table whose child rows precede their parents across batches), blob / JSON / DATE / bigint / -0 columns, a generated column, a view, a materialized view, a partial index and an assertion. `exportBundle` with `batchSize: 2` → `importBundle` into a fresh database → `report.ok`; `diff schema main` against the exported declaration is empty; every table's rows (ordered by primary key) are `sqlValueIdentical` to the source; the materialized view has its rows.
- **`errorPolicy: 'skip-row'`:** one NOT NULL-violating row in a three-row document → that row is reported with its document and row index, the other two are present.
- **`errorPolicy: 'abort'`:** a bad row in the second document → the first document's rows are present, later ones absent, `ok: false`.
- **Destructive guard:** the target has an extra table not in the bundle → with defaults, a `destructive` error listing `drop table`, and the catalog is unchanged; with `allowDestructive: true` the table is gone and the data loaded.
- **Corrupt middle document** under `skip-batch` → the other documents load, and the error carries a line number.
- **Truncated input** (trailer removed) → a `truncated` error, with earlier rows loaded.
- **Declaration guard:** a header declaration followed by `; drop table t` → a fatal `schema` error, and `t` still exists.
- **Orphan foreign key** in the bundle → a `foreign-key` error naming the constraint, with the rows present.

## Docs

Fill the import section of `docs/bundle.md`: options, the throw-vs-report rule, transaction-per-document semantics (not all-or-nothing across the file), the destructive guard, foreign keys off during load with verification after, the restored declaration, and the known limits. Add usage examples to the package README (Node file stream; browser `File.stream()`).

## TODO

- `read-documents.ts`: incremental document reader with positions.
- `import.ts`: header, schema phase (guard, plan, classify, confirm, apply, restore declaration), data phase (foreign keys off, per-document transaction, conflict clauses, error policies, progress, cancel), trailer checks, foreign-key verification, report.
- Export `importBundle` and its types from `src/index.ts`.
- Tests above.
- `docs/bundle.md` import section and README examples. `yarn docs:check`.
- `yarn build`, `yarn typecheck`, `yarn test`.

## Notes from the export ticket

What `bundle-package-format-and-export` left for this one to use (read `src/value-codec.ts` and `src/format.ts`):

- Parse each document with `PARSE_OPTIONS` (`version: '1.2'`, the package's own `!!binary` tag, `intAsBigInt`, `uniqueKeys`); use `TO_JS_OPTIONS` (`maxAliasCount: 0`) if calling `toJS` on the header or trailer. The package replaces `yaml`'s built-in `!!binary`, so do not pass `customTags: ['binary']`.
- `decodeValue(node)` returns a `SqlValue` and throws a plain `TypeError` for anything a bundle never holds (an alias, a foreign tag such as `!!timestamp`, malformed base64, a non-scalar map key). Wrap it into a `row` `BundleError` with the document and row index.
- Key names and the version are constants in `format.ts` (`HEADER_KEY`, `DATA_KEY`, `ROWS_KEY`, `TRAILER_KEY`, `BUNDLE_FORMAT_VERSION`). They and the codec are internal: `src/index.ts` exports only the format types, `BundleError` and the hook types, and `exportBundle`.
- `hooks.ts` has `notifyProgress`, `notifyError` (answers `'abort'` when the hook asked to stop) and `cancellation(signal, phase)`.
- `docs/bundle.md` § Import and the package README § Import currently say "Not implemented yet"; replace both. Misuse errors on the export side are `MisuseError`; use the same for invalid import options.
- Tests: `register.mjs` sets `TS_NODE_PROJECT`, and `tsconfig.test.json` uses `module: ES2022` with `moduleResolution: bundler` (the `@quereus/quereus/emit` subpath needs `exports` support). New spec files under `test/` are picked up as they are.
