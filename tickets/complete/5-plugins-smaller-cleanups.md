description: Fixed two real plugin/CLI bugs (a user cache setting was silently dropped; a table name was spliced into SQL text) and did a batch of dead-code / copy-paste cleanups across the plugin loader, CLI, and web UI. Reviewed and confirmed correct.
files:
  - packages/plugin-loader/src/config-loader.ts (toPluginSqlConfig; removed flattening toSqlValue)
  - packages/plugin-loader/src/plugin-loader.ts (protocol allowlist inside dynamicLoadModule)
  - packages/plugin-loader/src/index.ts (export toPluginSqlConfig)
  - packages/plugin-loader/test/config-channel.spec.ts (Bug 1 regression test)
  - packages/quoomb-web/src/stores/session/plugins.ts (uses toPluginSqlConfig; Bug 1 web path)
  - packages/quoomb-web/src/stores/sessionStore.ts (five fetch* actions → one helper)
  - packages/quoomb-cli/src/commands/dot-commands.ts (Bug 2 table_info; quoteIdentifier; typed away any)
  - packages/quoomb-cli/src/repl.ts (deleted 4 dead print* methods; node:readline; typed)
  - packages/quoomb-cli/src/bin/quoomb.ts (typed away any: CliOptions)
  - packages/quoomb-cli/package.json (dropped unused readline dep)
  - packages/shared-ui/src/index.ts (dropped orphan placeholder export)
----

## What this was

Grab-bag cleanup ticket: two genuine bugs plus dead-code / duplication cleanups
across the plugin loader, CLI, and web UI. Implemented, then reviewed.

## The two bugs (both real, both fixed)

- **Bug 1 — user cache config silently dropped.** The plugin config channel
  flattened config *objects* to JSON *strings*, but the IndexedDB plugin casts the
  value straight to an object (`config.cache as CacheOptions`), so a user's `cache`
  setting arrived as a string and was ignored. Fix stops flattening via a new
  exported `toPluginSqlConfig()` (objects/arrays are valid `SqlValue`s — the
  `JsonSqlValue` arm — so they pass through unchanged; only `undefined → null`).
  Both the CLI/loader path and the web path now call it.
- **Bug 2 — raw table name interpolated into SQL.** `.schema <table>` built
  `PRAGMA table_info(${tableName})` by splicing the identifier into SQL text. Fixed
  to bind as a parameter: `select cid, name, type, notnull, dflt_value, pk from
  table_info(?)` with `[tableName]`. Sibling audit: the CSV importer's
  `"${col}"` / `"${tableName}"` DDL splices switched to the engine's
  `quoteIdentifier()` (escapes embedded quotes).

## Cleanups

Protocol allowlist moved inside `dynamicLoadModule` (the load choke point) via a
shared `ALLOWED_PLUGIN_PROTOCOLS` const; dead REPL code removed (4 never-called
`print*` methods + unused `cli-table3`/`validateConfig` imports + dead `upperLine`);
unused `readline` dep dropped (`node:readline` builtin used); `any` eliminated across
quoomb-cli src; five copy-paste `fetch*` store actions collapsed into one
`fetchIntoActiveResult` helper; shared-ui orphan `placeholder` export dropped.

## Review findings

Read the full implement diff (fd470cef) first, then verified each claim against the
codebase. **No inline fixes were needed — the implementation is correct as written.**

**Correctness — checked, clean.**
- *Bug 1 end-to-end.* Traced config flow: `loadPluginsFromConfig → loadPlugin →
  dynamicLoadModule → register(db, config)`. Config is **never interpolated into
  SQL** — it is passed straight to the plugin's `register()`, so passing structured
  objects instead of JSON strings is safe on the direct-import path. `toPluginSqlConfig`
  passing objects through is type-sound (`JsonSqlValue` is a valid `SqlValue` arm).
  The new spec's observable round-trip (temp `file://` plugin captures received
  config, asserts `cache` is a deep-equal object) genuinely covers the loader leg.
- *Bug 2.* Confirmed `table_info` is a TVF taking a string arg
  (`packages/quereus/src/func/builtins/schema.ts`) whose columns include
  `cid, name, type, notnull, dflt_value, pk` — all six selected columns exist, and the
  render code reads exactly those. Parameter-bound TVF calls (`table_info(?)`) match the
  established `query_plan(?)` / `json_each(?)` pattern used across the engine tests and
  the web worker, so the `?` binds as a TVF argument correctly.
- *quoteIdentifier.* Verified exported from `@quereus/quereus`; emits bare for valid
  non-keyword names, quotes+escapes (`"` → `""`) otherwise — correct for CSV headers.
- *Dead-code removal.* Confirmed the four `repl.ts` `print*` methods were truly
  unreferenced. Note: `dot-commands.ts` has its **own** `printHelp` (line 51, called
  at line 27) — a different method, still live and correct to keep.
- *shared-ui `placeholder`.* Grepped quoomb-web: the only `placeholder` hits are CSS
  classes and HTML input attributes; the dropped string constant had no importers.
- *No orphan imports.* `SqlValue` in web `plugins.ts` is still used (line 100). The
  `fetchIntoActiveResult` refactor is behavior-preserving by inspection.

**Tests / lint — run, all pass.**
- `yarn build` → EXIT 0. `yarn lint` → EXIT 0 (quereus eslint+tsc; other packages
  no-op by design). `yarn test` → EXIT 0, ~3m46s: plugin-loader **3 passing** (new
  spec included), quereus core 6479, quoomb-web 74, store/isolation/sync/coordinator
  suites all green. The `[Sync]` / `[StoreModule]` / `Data change listener error`
  console lines in the output are test-**injected** error-path assertions, not
  failures.

**Tripwires (recorded here, no ticket, no code change):**
- *Web Comlink leg of Bug 1 is not automatically tested.* The web path crosses the
  Comlink worker boundary (`api.loadModule`), which structured-clones the config.
  Structured clone preserving a plain object is guaranteed by spec (low risk), but no
  automated test exercises it. A live app check (set a `cache` config on the IndexedDB
  plugin, confirm it takes effect) is the honest confirmation. Left as knowledge, not
  work — the mechanism is sound.
- *Empty-CSV import.* `.import` on a header-only / empty CSV would hit
  `Object.keys(firstRow)` with `firstRow` undefined and throw. This is **pre-existing**
  (the old code had the identical `parseResult.data[0]` access) and unrelated to this
  ticket's changes, so it was deliberately not touched here. If CSV import robustness
  is ever revisited, guard the empty-`rows` case.

**Deferred coverage (not a defect — implementer already flagged):**
- quoomb-cli ships **no test harness** (`vitest --passWithNoTests`), so Bug 2's
  `table_info(?)` fix and the `quoteIdentifier` CSV change are correct-by-construction
  and pattern-matching but have no automated test. A first CLI spec driving
  `DotCommands` would be the highest-value follow-up. **Not filed as a ticket** — it is
  a general testing-debt observation, not a defect in this change; the current green is
  a floor, not proof, and that is already stated honestly in the handoff.

## Validation performed

- `yarn build` → EXIT 0 (all packages).
- `yarn lint` → EXIT 0.
- `yarn test` (full workspace) → EXIT 0, 3m46s. plugin-loader 3 passing (new spec);
  quereus core 6479; quoomb-web 74; all store/isolation/sync suites green.
