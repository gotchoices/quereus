description: Fixed two real plugin/CLI bugs (a user cache setting was silently dropped; a table name was spliced into SQL text) and did a batch of dead-code / copy-paste cleanups across the plugin loader, CLI, and web UI.
files:
  - packages/plugin-loader/src/config-loader.ts (new toPluginSqlConfig; removed flattening toSqlValue)
  - packages/plugin-loader/src/plugin-loader.ts (protocol allowlist moved inside dynamicLoadModule)
  - packages/plugin-loader/src/index.ts (export toPluginSqlConfig)
  - packages/plugin-loader/test/config-channel.spec.ts (new — Bug 1 regression test)
  - packages/quoomb-web/src/stores/session/plugins.ts (uses toPluginSqlConfig; Bug 1 web path)
  - packages/quoomb-web/src/stores/sessionStore.ts (five fetch* actions → one helper)
  - packages/quoomb-cli/src/commands/dot-commands.ts (Bug 2 table_info; quoteIdentifier; typed away any)
  - packages/quoomb-cli/src/repl.ts (deleted 4 dead print* methods; node:readline; typed)
  - packages/quoomb-cli/src/bin/quoomb.ts (typed away any: CliOptions)
  - packages/quoomb-cli/package.json (dropped unused readline dep)
  - packages/shared-ui/src/index.ts (dropped orphan placeholder export)
----

## What this was

A grab-bag review ticket: two genuine bugs plus a set of dead-code / duplication
cleanups across the plugin loader, CLI, and web UI. All items in the source
ticket were addressed. `yarn build` and `yarn test` both pass (full suite green,
3m38s; new plugin-loader spec included).

## The two real bugs (fixed + how to check)

### Bug 1 — user cache config was silently dropped

**Root cause.** The plugin config channel flattened config *objects* to JSON
*strings* (`config-loader.ts` `toSqlValue` did `JSON.stringify(value)`; the web
store did the same inline). The IndexedDB plugin then does
`config.cache as CacheOptions` — casting a *string* to an object. So a user's
`cache` setting arrived as `"{...}"` and was silently ignored.

**Key insight.** `SqlValue` already includes `JsonSqlValue` (`{ [k]: JSONValue }
| JSONValue[]`), so config objects are *valid* SqlValues and never needed
flattening. The fix stops flattening: a new exported `toPluginSqlConfig()` passes
JSON objects/arrays through unchanged (only `undefined → null`). Both the CLI/loader
path (`config-loader.ts`) and the web path (`session/plugins.ts`) now call it — this
also de-duplicates the one piece of the "plugin-load loop" that was truly copy-pasted.

**Test.** `packages/plugin-loader/test/config-channel.spec.ts`:
- `toPluginSqlConfig` keeps nested objects/arrays as objects (not strings).
- **Observable round-trip:** writes a temp `file://` ESM plugin that records the
  config it receives, loads it through `loadPluginsFromConfig`, and asserts the
  received `cache` is the original object (deep-equal, `typeof === 'object'`).

**Reviewer, please scrutinize:**
- The observable round-trip covers the **loader path** (`loadPluginsFromConfig` →
  `dynamicLoadModule` → `registerPlugin` → plugin). The **web path** additionally
  crosses the Comlink worker boundary (`api.loadModule`), which structured-clones
  the config. That leg is *not* exercised by an automated test — it relies on
  structured clone preserving a plain object (low risk, but unverified here). A
  manual check in the running web app (set a `cache` config on the IndexedDB
  plugin and confirm it takes effect) would close this gap.

### Bug 2 — raw table name interpolated into SQL

`dot-commands.ts` built `PRAGMA table_info(${tableName})` by splicing the raw
identifier into SQL text. `table_info` is a table-valued function taking the table
name as a **string argument**, so the fix binds it as a parameter:
`select cid, name, type, notnull, dflt_value, pk from table_info(?)` with
`[tableName]` — no interpolation. The TVF-with-bound-parameter shape is already
used across the codebase (`query_plan(?)`, `json_each(?)`), so it's an established
pattern, but note: **quoomb-cli has no test harness** (`vitest --passWithNoTests`),
so this is not covered by an automated test. Manual check: run `.schema <table>`
in the REPL and confirm the column table still renders.

**Sibling audit (same file).** The CSV importer interpolated column/table names as
`"${col}"` / `"${tableName}"` (double-quoted but *not* escaping embedded quotes —
a header containing `"` would break the DDL). Switched those to the engine's
`quoteIdentifier()` helper (`CREATE TABLE`, column defs, and `INSERT` column list).
This is a small behavior change (bare identifiers now emit unquoted; special/keyword
names get correctly quoted+escaped) — worth a glance, again untested by CLI harness.
Out of scope but noted: `quoomb-web/src/worker/quereus.worker.ts:509` has the same
CSV-import shape but uses *sanitized* names (already defensive), in a different
package — left as-is.

## Cleanups done

- **Protocol allowlist moved inside `dynamicLoadModule`.** Was only in
  `validatePluginUrl` (a separate pre-flight function), so callers hitting the
  loader directly (e.g. the web worker's `loadModule`) bypassed it. Now enforced at
  the loader itself via a shared `ALLOWED_PLUGIN_PROTOCOLS` const (`https:`, `file:`);
  `validatePluginUrl` reuses the same const.
- **Shared plugin-load loop.** Extracted the one genuinely-duplicated piece
  (config→SqlValue encoding = `toPluginSqlConfig`). The full loop bodies are NOT
  unified: the web app must load through the Comlink worker (`api.loadModule`) rather
  than importing in-process, so unifying would force a worker-boundary dependency
  edge. This is documented with a greppable `NOTE:` in `config-loader.ts` above
  `loadPluginsFromConfig`.
- **Dead REPL code removed.** `repl.ts` lost four never-called methods
  (`printResults`, `printTable`, `printError`, `printHelp`, ~67 lines) plus a now-unused
  `cli-table3` import, a dead `validateConfig` import, and a dead `upperLine` local.
- **Dead `readline` dep removed** from `quoomb-cli/package.json` (Node's built-in
  `readline` is what's used; switched the import to `node:readline` for clarity).
  `yarn.lock` reconciled.
- **`any` eliminated** across all of quoomb-cli src (dot-commands, repl, bin):
  `CliOptions` interface, `CsvRow` type, `Record<string, SqlValue>[]` rows,
  `ReadlineInterface`, `PluginSetting`, `unknown` for error/config boundaries.
  A grep for `: any|as any|any[]` in `quoomb-cli/src` now returns nothing — no
  deferred `NOTE:` was needed.
- **Five copy-paste `fetch*` actions collapsed** (`sessionStore.ts`) into one
  `fetchIntoActiveResult(get, set, field, label, run)` helper; each action is now a
  one-liner. Behavior-preserving.
- **shared-ui orphan constant dropped.** The `placeholder` string export was
  consumed by nothing (only a package.json dep edge from quoomb-web). Replaced with
  `export {}` and a comment pointing at where real component exports will land.

## Validation performed

- `yarn build` → EXIT 0 (all packages).
- `yarn workspace @quereus/plugin-loader run typecheck` / `@quereus/quoomb-web
  run typecheck` → 0. `@quereus/quoomb-cli run build` (tsc) → 0.
- `yarn test` (full workspace) → EXIT 0. plugin-loader: 3 passing (new spec);
  quereus core 429; web 74; store/indexeddb/sync suites all green.

## Known gaps / where the reviewer should push

1. **No CLI test harness.** Bug 2's `table_info(?)` fix and the `quoteIdentifier`
   CSV change are correct by construction and by matching established patterns, but
   are **not** covered by automated tests (quoomb-cli ships no vitest specs). If the
   reviewer wants coverage, adding a first CLI spec (or an integration test that
   drives `DotCommands`) would be the highest-value follow-up — treat the current
   green as a floor, not proof.
2. **Web Comlink leg of Bug 1** is untested (see Bug 1 above) — a live app check is
   the honest way to confirm structured clone preserves the config object.
3. **fetch\* refactor** is behavior-preserving by inspection; the web test suite
   passes but I did not confirm those 5 actions are directly asserted anywhere.
