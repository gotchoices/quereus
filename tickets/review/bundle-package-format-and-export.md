description: Create a new package that saves a database's schema and/or data into a single compact `bundle.yaml` file, in batches, reporting progress and errors as it goes.
prereq: schema-export-declaration
architecture: docs/bundle.md
files: packages/quereus-bundle/src/export.ts, packages/quereus-bundle/src/value-codec.ts, packages/quereus-bundle/src/hooks.ts, packages/quereus-bundle/src/format.ts, packages/quereus-bundle/src/index.ts, packages/quereus-bundle/test/export.spec.ts, packages/quereus-bundle/test/value-codec.spec.ts, packages/quereus-bundle/package.json, packages/quereus-bundle/register.mjs, packages/quereus-bundle/tsconfig.json, packages/quereus-bundle/tsconfig.test.json, packages/quereus-bundle/README.md, docs/bundle.md, docs/.stability.json, docs/stability.md, packages/quereus/README.md, tsconfig.build.json, package.json, README.md, AGENTS.md, yarn.lock, tickets/implement/bundle-import.md
----
## What landed

New package `@quereus/bundle` (`packages/quereus-bundle`) with the bundle format (version 1), its value codec, shared hook and error types, and `exportBundle(db, options): AsyncIterable<string>`. Import is the next ticket (`bundle-import`); I appended a "Notes from the export ticket" section to it naming the codec API it should use.

- `src/format.ts`: header / data / trailer types, key constants, `BUNDLE_FORMAT_VERSION = 1`.
- `src/value-codec.ts`: `encodeValue` / `encodeString` / `decodeValue`, plus the shared `yaml` option constants (`DOCUMENT_OPTIONS`, `STRINGIFY_OPTIONS`, `PARSE_OPTIONS`, `TO_JS_OPTIONS`).
- `src/hooks.ts`: `BundlePhase`, `BundleProgress`, `BundleError` (structured, with `cause`), `BundleHooks`, plus `notifyProgress` / `notifyError` (a throwing hook is logged with `console.error`, as `quereus-store`'s listeners are) and `cancellation(signal, phase)`.
- `src/export.ts`: `exportBundle`. `src/index.ts` exports only the format types, `BundleError` and the hook types, and `exportBundle` / `ExportOptions` / `DEFAULT_BATCH_SIZE`. The codec stays internal.
- Wiring: `tsconfig.build.json` reference, root `build:bundle` / `pub:bundle` scripts, `pub:bundle` in the `pub` chain after isolation, `docs/.stability.json` (doc and package both Experimental), a row in the `docs/stability.md` assignment table, README banner, root README and AGENTS.md package lists, docs index link in `packages/quereus/README.md`.
- `docs/bundle.md`: format, value encoding, export API and behaviour, rejected alternatives. Its `## Import` section says "Not implemented yet" for `bundle-import` to replace.

## Deviations from the ticket (please check)

- **Rows are read with `db.prepare(sql).iterateRows()`** (positional rows), not `db.eval` (which yields objects keyed by column name). Positional rows match the format directly and avoid building objects keyed by user column names. The statement is finalized in `finally`.
- **The package registers its own `!!binary` tag** instead of passing `customTags: ['binary']`. `yaml`'s built-in one base64-encodes a typed array's whole backing `ArrayBuffer` rather than its view (a `subarray` would export the wrong bytes), reads into a Node `Buffer`, and decodes malformed base64 without complaint. Ours uses `btoa` / `atob` (globals in Node, browsers and current React Native), returns a plain `Uint8Array`, and refuses malformed text. The codec test covers a `subarray` view.
- **Float spelling:** a whole number past the safe range is written `1e+20` (`toExponential` via `format: 'EXP'`), not `1.0e+20` as in the ticket's example. `-0` is `-0.0`. Both read back as YAML floats.
- **Two writer options added:** `flowCollectionPadding: false` (gives `[1, a]` as in the spec example instead of `[ 1, a ]`) and `doubleQuotedMinMultiLineLength: Infinity`. Without the second, `yaml` folds a double-quoted string over 40 characters that contains `\n` across several lines, which would break one-row-per-line. The codec test covers it with a long two-line string.
- **The declaration is one line.** `astToString` writes a `declare schema` on one line, so the "literal block scalar" is a one-line `|-` block. A multi-line rendering would need an engine stringifier change.
- **Error delivery:** invalid options throw `MisuseError` synchronously from `exportBundle`. Everything else is a `BundleError` thrown from the iterator, and every `BundleError` goes to `onError` first, including the ones that are then thrown.
- **The test for early stop breaks after the first data document, not the first chunk.** The first chunk is the header, which is yielded before `begin`, so breaking there would not exercise the transaction cleanup. The test also runs an `insert` afterwards, which would hang if the execution lock were still held.
- **Under `skip-table`, rows read before the failure in the unwritten batch are still written** and counted in the trailer entry, beside its `error`.
- **The read transaction** is committed after a finished or early-stopped export and rolled back after a failure (a rollback error is logged so the original error survives).
- **Progress:** phase `schema` once per declaration; phase `data` at table start (`rowsDone: 0`) and after each data document. `batchIndex` is the data document's index across the whole run.
- **Test setup differs from the `quereus-isolation` template**, which does not work for this package as-is. `register.mjs` sets `TS_NODE_PROJECT` / `TS_NODE_ESM` (like `quereus-store`), and `tsconfig.test.json` uses `module: ES2022` + `moduleResolution: bundler`. Without them, ts-node either compiled against its default lib (rejecting `Error`'s `cause`) or Node's own type stripping loaded the specs and failed to import the engine. `bundler` resolution is needed for the `@quereus/quereus/emit` subpath (`astToString` is not on the main entry). `tsc -p tsconfig.test.json --listFiles` lists both specs.

## Tests added

- `test/value-codec.spec.ts`
  - *round-trips every kind of SqlValue through YAML text*: every row of the ticket's value table plus the listed edge values (look-alike strings, line breaks including U+0085/U+2028/U+2029, a long multi-line string, lone surrogates, emoji, NUL, `-0`, `1e20`, `2^53`, NaN, ±Infinity, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER + 1n`, −2^63, empty / full / `subarray` blobs, nested JSON with a `__proto__` key). It checks `sqlValueIdentical`, the same `typeof`, `Object.is` for numbers, that the row stays on one line, that the text is valid UTF-8 (no raw unpaired surrogate), and that a decoded `__proto__` key is an own property rather than the prototype.
  - *refuses to encode a value that has no lossless form*: `Date`, `Map`, class instance, and JSON holding a `Date`, `bigint` or `undefined`. Not in the ticket's test list; it pins the "never a lossy coercion" rule. Cut it if you disagree.
  - *refuses YAML a bundle never holds*: alias, `!!timestamp`, a local tag, `!!set`, malformed base64, a non-scalar map key. Not in the ticket's list either; it pins the untrusted-input refusals that import will rely on.
- `test/export.spec.ts`
  - *golden*: a `"order"` (keyword name, quoted in the select) / `item` (FK child, generated column) database with a view, `batchSize: 2` → exact text with `created` masked. It pins the format, parent-first ordering (`item` sorts first by name), the omitted view and generated column, the split batch, look-alike string quoting and the trailer.
  - *early stop*: `break` after the first data document → `getAutocommit() === true`, and a following `insert` succeeds.

## Known gaps

- **No automated test for** `skip-table`, a table read failure, cancellation through `signal`, `onError` returning `'abort'`, or progress events. I checked `skip-table` and `abort` with a manual probe: a UDF returning a `Date` was stored in an `any` column, and the export wrote rows 1, 2, 4 plus `{rows: 3, error: "Cannot export column 'v' of row 3 in main.a: cannot encode a Date value"}`, continued to the next table, and under `abort` threw a `value` `BundleError` with the database back in autocommit.
- **The export holds the database's execution lock between yielded strings**, because one statement streams each table. A consumer that runs a statement on the same database inside its loop deadlocks. This is documented in the JSDoc, `docs/bundle.md` and the README. A consumer that stops calling `next()` without `return()` leaves the export's transaction open; for-await always calls `return()`.
- **Declarations are read before `begin`**, so the schema text and the rows are not taken in one transaction. Harmless under the documented "don't write during an export" rule.
- **Tripwire:** `yaml` leaves DEL, C1 controls, U+FEFF and U+FFFE/U+FFFF raw inside strings. That is valid UTF-8 and `yaml` reads it back, but a strict YAML 1.2 parser would reject the file. `NOTE:` at `encodeString` in `value-codec.ts`.
- Unhandled oddities: a table whose columns are all generated produces an invalid `select` (reported as a `batch` error); `schemas: []` writes an empty bundle rather than being refused; foreign keys across schemas do not affect order (schemas go in the order given).

## Validation

`yarn build` clean; `yarn typecheck` clean; `yarn lint` clean; `yarn docs:check` OK; `yarn test` all workspaces pass (quereus 11189 passing / 26 pending, `@quereus/bundle` 5 passing, no failures elsewhere).

Usage to try by hand: `for await (const s of exportBundle(db, { batchSize: 2 })) process.stdout.write(s)` on any database. Then try `{ data: false }` (no `tables`, trailer `tables: []`), `{ schema: false }` (no `schemas`), `{ tables: (_, t) => t !== 'x' }`, `{ batchSize: 0 }` (MisuseError at call), `{ schemas: ['nope'] }` (`schema` BundleError on first `next()`), and an `AbortController` aborted from `onProgress` (a `cancelled` error after the current document).
