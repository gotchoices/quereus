description: Review the new bundle import: loading a `bundle.yaml` file into a database by applying its schema safely, inserting its rows in batches, continuing past bad rows or batches when asked to, and reporting progress and every problem.
prereq: bundle-package-format-and-export
architecture: docs/bundle.md
files: packages/quereus-bundle/src/import.ts, packages/quereus-bundle/src/import-run.ts, packages/quereus-bundle/src/import-schema.ts, packages/quereus-bundle/src/import-data.ts, packages/quereus-bundle/src/import-verify.ts, packages/quereus-bundle/src/bundle-documents.ts, packages/quereus-bundle/src/read-documents.ts, packages/quereus-bundle/src/index.ts, packages/quereus-bundle/test/import.spec.ts, packages/quereus-bundle/README.md, docs/bundle.md, packages/quereus/README.md
----
## What landed

`importBundle(db, source, options?)` in `@quereus/bundle`, with its types (`ImportOptions`, `ImportReport`, `ImportTableReport`, `SchemaPlan`, `BundleSource`) exported from `src/index.ts`. `docs/bundle.md` § Import is the specification: options, the throw-or-report rule, per-document transactions, the destructive guard, foreign keys off during the load with verification after, the restored declaration, and known limits. The package README has Node and browser examples.

Layout, one file per stage:

- `read-documents.ts`: async generator over `string | Iterable<string> | AsyncIterable<string>`. It feeds the `yaml` library's incremental `Parser` (`parse(chunk, true)`, then `parse('', false)`) into a `Composer` built with the codec's `PARSE_OPTIONS`. Each yielded document carries its index, its first YAML error with line and column, and a `locate(offset)` function. Line numbers come from a small `StreamLineCounter` that forgets lines of documents already handed out. The library's `LineCounter` keeps one number per line of the whole file, which for a big bundle is one per row. A non-string chunk throws `MisuseError`.
- `bundle-documents.ts`: header, data and trailer shape checks, each refusal a positioned `format` error (`version` for an unknown version). Header and trailer go through `toJS(TO_JS_OPTIONS)`. Data documents are read node by node so each cell goes through `decodeValue`.
- `import-run.ts`: options, validation into settings (`MisuseError`), and the `ImportRun` state that builds the report: `report` / `fail` / `isCancelled`, and the `stopped` / `abortRequested` / `cancelled` flags.
- `import-schema.ts`: the declaration guard (exactly one non-logical `declare schema` naming the entry's schema), saving and restoring the declared schema plus its seed rows, `diff schema`, the destructive classification, `confirmSchemaPlan`, and `apply schema … options (…)`.
- `import-data.ts`: the `DataLoader` class. It checks the target table, prepares one insert per table (conflict clause, parameters declared `ANY`), runs one transaction per document, applies the three error policies, fires progress, and checks the trailer.
- `import-verify.ts`: the foreign-key check after the load.
- `import.ts`: `importBundle` and the order of the phases. It reads the header, runs the schema phase, then the data phase with `foreign_keys` off, restored in a `finally`. Verification follows, and the source iterator is closed in a `finally`.

## Two places that deviate from the ticket's text, with evidence

- **Foreign-key verification needed more than calling `validateForeignKeyOverExistingRows`.** Its own docstring warns that when the live child table already declares the key, `ruleAntiJoinFkEmpty` folds the orphan scan to empty. So `import-verify.ts` swaps the child's catalog record for a copy without `foreignKeys` while the scan runs (`schema.addTable`), then restores it in a `finally`. This is the same swap `runtime/emit/materialized-view-helpers.ts` uses. I checked it by disabling the swap: the orphan test then fails (no `foreign-key` error is reported). Reviewer: judge whether an outside package should touch `Schema.addTable` like this. The alternative is an engine helper that does the swap.
- **Insert parameters are declared `ANY`** (`anyTypedParameters`). Without that, a statement pins each parameter's type to the first value bound to it. The round-trip test then failed: a REAL column whose first row is `-0` (an integer-looking number) refused `0.1` in the next row.

## Decisions where the ticket was silent (check these)

- `confirmSchemaPlan` is asked only for a non-empty plan. `apply schema` still runs on an empty plan, since it creates a missing non-main schema. A hook that throws is logged and counts as declining.
- Destructive means any `drop` (including the drop half of a view or index recreate), plus `alter table` drop column, drop constraint, or `alter column … set data type`. Under `renamePolicy: 'deny'`, rename statements count too, because `diff schema` always plans with `'allow'`, and `deny` turns those renames into drop plus create. A planned statement that does not parse is counted as destructive, with a log line.
- A logical-schema declaration is refused. The exporter never writes one.
- In `'verify'` mode a schema gets a `schemas` report entry with an empty `ddlApplied`.
- Table-level problems skip the table under every error policy, including `'abort'`, as the ticket's wording says. These are: a data document naming a table not in the manifest, a missing target, a maintained target, a missing or generated column. Each is reported once. Rows of a rejected table count as `rowsFailed`.
- A table the `tables` filter rejects is left out of `report.tables` and out of the trailer check.
- Under `'abort'` and `'skip-batch'`, a failed document is one `batch` error carrying the failing row's index when known, and `cause` is the row decode error or the engine error. Only `'skip-row'` produces `row` errors.
- A document that is invalid YAML or the wrong shape is a `format` error with line and column, handled like a failed batch under the policy. Its rows count as read and failed when the row sequence can still be read. Otherwise they are not counted, and the trailer then reports `count-mismatch`.
- A trailer entry with `error` is reported as kind `truncated`. A manifest table missing from the trailer, or a trailer entry for an unlisted table, is a `format` error. A document after the trailer is a `format` error, and nothing past it is read.
- A failure reading the source itself (the stream throws) is a `truncated` error at phase `read`, and the run stops.
- Verification runs after `errorPolicy: 'abort'` stopped the load, since the committed rows still need checking. It is skipped when the run was cancelled or `onError` answered `'abort'`. It walks every schema (`schemaManager._getAllSchemas()`, as `quereus-sync` does), so a child in another schema whose parent was updated is covered.

## Tests (`test/import.spec.ts`, 8 tests; package total 14 passing)

- Round trip: foreign keys, a self-referencing table whose leaves come a batch before their parent (batch size 2), blob / JSON / DATE / bigint (both signs, past 2^53) / -0 / 0.1 columns, a generated column, a view, a materialized view, a partial index and an assertion. It checks `report.ok`, that the database's declaration is restored (none), that `foreign_keys` is back on, that `diff schema` against the exported declaration is empty, and that the rows of every table and the materialized view are identical to the source (`sqlValueIdentical`). With `foreign_keys` left on during the load, this test fails at the leaves' batch.
- `skip-row`: a NOT NULL violator in a three-row document gives one `row` error at document 1, row 1. The other rows stay, and the per-table counters are exact.
- `abort`: a failure in document 2, row 1 gives one `batch` error. Document 1's rows stay and document 3 is not loaded.
- Destructive guard: an extra target table gives a `destructive` error naming `drop table`, with the catalog unchanged. With `allowDestructive` the table is dropped and the data loaded.
- Invalid YAML (a bad escape) in the middle document under `skip-batch` gives a `format` error at line 14. The other documents load.
- Trailer removed gives a `truncated` error, with the earlier rows loaded.
- Declaration followed by `; drop table t` gives a fatal `schema` error, and `t` survives.
- An orphaned child row gives a `foreign-key` error naming `c_to_p`, with the row present. This test pins the catalog swap.

Not tested, verified by reading the code only: `'verify'` mode, `onConflict: 'skip'` / `'update'`, `confirmSchemaPlan`, `renamePolicy`, cancellation, `onError` returning `'abort'`, rollback failure, a source that throws, a non-string chunk, a document after the trailer, `count-mismatch`, and trailer `error` entries. Add a test only where it pins a branch with real logic, for example `'update'` writing only non-key columns.

## Known gaps / things to look at

- `onConflict: 'update'` targets the primary key. A conflict on another UNIQUE constraint still fails the row, which then goes through the error policy.
- `db.prepare` compiles lazily, so an insert that fails to compile shows up as a failed batch on first use, not as a one-time table rejection.
- The `tables` filter is called unguarded, as the exporter does. If it throws, the error propagates out of `importBundle`, with cleanup still done in the `finally` blocks.
- `foreign_keys` is off for the whole database while the import runs. The docs say not to run other statements during an import, and nothing enforces that.
- With `allowDestructive`, an `apply schema` failure after a destructive step leaves the schema partly migrated (the engine's stated limit). The docs link to it.
- Cross-table CHECKs and assertions judged at each commit: documented as a limit, not tested.

## Filed

- `tickets/backlog/bug-optimizer-trusts-foreign-keys-written-with-enforcement-off.md`. Verified: after a child row is inserted with `foreign_keys` off, `not exists (select … from parent …)` counts 0 orphans while a left join counts 1. The import makes this reachable whenever a bundle carries an orphan, because it reports the violation but keeps the row. `docs/bundle.md` § Verification warns users to fix such data.

## Validation run

`yarn build`, `yarn typecheck` (all workspaces), `yarn test` (all workspaces, all passing), `yarn docs:check` (OK).
