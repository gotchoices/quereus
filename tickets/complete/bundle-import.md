description: Loading a `bundle.yaml` file into a database: applying its schema safely, inserting its rows in batches, continuing past bad rows or batches when asked to, and reporting progress and every problem. Reviewed; a chunked-reading defect was fixed.
prereq: bundle-package-format-and-export
architecture: docs/bundle.md
files: packages/quereus-bundle/src/import.ts, packages/quereus-bundle/src/import-run.ts, packages/quereus-bundle/src/import-schema.ts, packages/quereus-bundle/src/import-data.ts, packages/quereus-bundle/src/import-verify.ts, packages/quereus-bundle/src/bundle-documents.ts, packages/quereus-bundle/src/read-documents.ts, packages/quereus-bundle/src/index.ts, packages/quereus-bundle/test/import.spec.ts, packages/quereus-bundle/README.md, docs/bundle.md, packages/quereus/README.md
----
## What landed

`importBundle(db, source, options?)` in `@quereus/bundle` (implemented in `ticket(implement): bundle-import`). It reads a bundle one YAML document at a time from a string or a sync/async iterable of strings. It applies or verifies each header schema declaration with `declare schema` / `diff schema` / `apply schema`, behind a statement-kind guard and a destructive-plan guard, and restores the database's own declaration afterwards. It loads each data document in its own transaction with `foreign_keys` off, under the `abort` / `skip-batch` / `skip-row` error policies and the `abort` / `skip` / `update` conflict modes. It checks the trailer's row counts, then verifies every foreign key whose child or parent table received rows. Everything goes into an `ImportReport`. `docs/bundle.md` § Import is the specification. The package README has Node and browser examples.

One file per stage: `read-documents.ts` (streaming YAML reader with line positions), `bundle-documents.ts` (document shape checks), `import-run.ts` (options, run state, report), `import-schema.ts`, `import-data.ts` (`DataLoader`), `import-verify.ts`, `import.ts` (phase order and cleanup).

## Review findings

### Defects found and fixed in this pass

- **Chunked sources could misread the header (major, fixed).** The `yaml` library (2.9.0) misreads its incremental input when a chunk boundary falls inside a line's indentation before `- key: value` directly under a key. Example: `tables:\n ` followed by ` - schema: main\n    table: t` composes as a nested compact mapping. That is exactly the exporter's `schemas:` and `tables:` header shape. Checked by splitting a small bundle at every offset: 1 of 176 split points broke it. Feeding one-character chunks made the header a fatal `format` error and loaded nothing. A real Node or browser stream hits this only when a 64 KB-ish chunk boundary lands on that one byte, which requires a header larger than one chunk. For such a file it fails every time. Fix: `read-documents.ts` now regroups chunks so each piece fed to the parser ends at a line end (`wholeLines`). Re-running all split points gives 0 failures. A line that spans chunks is joined once from its parts, so it costs its length rather than chunks × length. Line-boundary splits were already correct in the probe. Pinned by changing the existing YAML-error test to feed the bundle one character at a time. That covers every boundary and line counting across chunks, without adding a test.
- **`onError` answering `'abort'` under `skip-row` kept loading the document's remaining rows (minor, fixed).** Verified with a probe: after the hook asked to abort at row 0, rows 1 and 2 still ran and row 2 committed. Each row commits on its own under `skip-row`, so `applyRowByRow` now stops before the next row once the run has stopped. `docs/bundle.md` § Data phase now says so. No test was added, because this is a one-line guard on a flag.
- **Docs: the declaration guard's scope (minor, fixed).** Verified that a bundle declaration can declare `table t (…) using memory('anything', 42)`. The guard limits the statement kind, not which registered virtual-table module or module arguments a declared table uses. `docs/bundle.md` § Schema phase item 1 now says this and points untrusted-source imports at `confirmSchemaPlan` (which receives the DDL including the `using` clause) or `schema: 'skip'`.

### Checked and fine (by running probes, deleted afterwards)

- `onConflict: 'update'` overwrites the non-key column in place and inserts new keys. `'skip'` keeps stored rows and counts them in `rowsApplied`, as documented.
- `schema: 'verify'` against a differing table gives one fatal `schema` error listing `ALTER TABLE t DROP COLUMN w`.
- `confirmSchemaPlan` returning false: a destructive plan is refused as `destructive` before the hook is asked, as documented.
- A wrong trailer count gives `count-mismatch`. A document after the trailer gives a `format` error and is not loaded.
- A pre-aborted `signal` gives `cancelled`, `report.cancelled`, and loads nothing.
- A non-string chunk, or a database inside a transaction, throws `MisuseError`.
- `apply schema` inserts declared seed rows only `with seed`, which the import never passes, so a bundle cannot smuggle rows in through seeds.
- Restoring the declaration: `removeDeclaredSchema` also clears the applied-state snapshot and lens state for that name. `setDeclaredSchema` keeps the snapshot, but the snapshot also compares the declaration's rendering, so a later application `apply schema` cannot take a wrong fast path.
- `foreign_keys` is read when a statement is built. The inserts are prepared lazily after the option is switched off, so they skip the checks, and the option is restored in a `finally`.

### Implementer's open questions, judged

- **Catalog swap in `import-verify.ts`:** accepted. The engine's `validateForeignKeyOverExistingRows` docstring requires exactly this of a caller whose child declares the key, and `materialized-view-helpers.ts` does the same strip-scan-restore. Recorded a `NOTE:` tripwire at `withoutDeclaredForeignKeys`: if a third caller needs it, export an engine helper.
- **`ANY`-typed insert parameters:** correct. `Statement` pins undeclared parameter types from the first bind, and a declared type map is never extended.

### Tripwires recorded

- `import-data.ts` `statementFor`: `prepare` compiles on first run, so an insert that cannot compile fails each document, or each row under `skip-row`, instead of rejecting the table once. `Statement.compile()` is `@internal` and stripped from the public types, so the package cannot compile eagerly. The target checks leave no known compile failure. `NOTE:` at the site.
- `import-verify.ts` `withoutDeclaredForeignKeys`: the catalog-swap pattern, as above.

### Considered, no action

- Implementer's known gaps: `onConflict: 'update'` targets only the primary key; `tables` filter called unguarded; `foreign_keys` off database-wide during an import; a partial migration after a destructive `apply schema` failure; cross-table CHECKs judged per document. All are documented in `docs/bundle.md` or the README and match engine limits. None needs a ticket.
- A damaged document belonging to a table the `tables` filter excludes is skipped without an error. That is consistent with the filter's meaning, so no change.
- Tests: the 8 implement-stage tests each pin a distinct documented behaviour (round trip, each error policy, the destructive guard, a YAML error, truncation, the declaration guard, foreign-key verification with the catalog swap). None restates the implementation, so none was cut. The only test change is the chunking above.
- No new tickets filed. The implementer's `backlog/bug-optimizer-trusts-foreign-keys-written-with-enforcement-off.md` is well-formed and stands.

### Validation

`yarn workspace @quereus/bundle run build`, `typecheck`, and `test` (14 passing). `yarn docs:check`: OK. `yarn test` across all workspaces: all passing, none failing.
