description: Four packages used to report a passing test run while containing zero test files; this reviewed the "green means nothing" state package by package and either explained it, tested it, or filed the gap.
files:
  - packages/quoomb-cli/package.json (test script NOTE updated)
  - packages/quoomb-cli/test/dot-commands.spec.ts (new smoke spec)
  - packages/quoomb-cli/src/commands/dot-commands.ts (bug fix, see below)
  - packages/shared-ui/package.json (test script NOTE updated)
  - packages/plugin-loader/package.json (test script NOTE updated)
  - tickets/backlog/debt-plugin-loader-test-coverage.md (new — untested surface)
  - packages/quoomb-web (no change — already has real coverage, see below)
----

## Starting state vs. actual state

The ticket's premise (four packages green via `vitest run --passWithNoTests`
with zero spec files) was **partially stale** by the time this ran — prior
work had already landed real tests in two of the four:

- **quoomb-web**: `src/__tests__/` has 5 spec files, 74 passing tests
  (configStore, sessionStore, settingsStore, sync-local-create-drain,
  sync-maintenance). This is real coverage of real logic. No longer an
  "empty green" package — left untouched, no NOTE needed. (`--passWithNoTests`
  stays in the script regardless, harmless.)
- **plugin-loader**: `test/config-channel.spec.ts` already existed (3
  passing tests) covering the plugin-config channel (`toPluginSqlConfig` +
  `loadPluginsFromConfig` round-trip — the "structured config silently
  flattened to a JSON string" regression). Real, but narrow: most of the
  module (URL/npm-spec parsing, CDN resolution, protocol allowlist
  rejection, env-var interpolation) is still untested. See below.

So only **shared-ui** was genuinely zero-test-files at the unit level, plus
**quoomb-cli** which had zero specs but real logic worth guarding.

## Per-package outcome

**shared-ui** — `src/index.ts` is literally `export {}`; the package ships
**zero components** right now (a placeholder). Kept test-free; updated the
`//test` NOTE in `package.json` to say so plainly and point future readers at
"verify via quoomb-web once components land" rather than the previous
generic "no test files yet" text (which was accurate but didn't say *why*
that's OK).

**quoomb-cli** — has real logic: config-path resolution precedence,
CSV-import column-type inference, dot-command dispatch (`.tables`,
`.schema`, `.import`, `.export`, `.plugin ...`). Added
`test/dot-commands.spec.ts`, a smoke spec (4 tests, not exhaustive) that:
exercises `DotCommands.listTables()` / `showSchema()` against a real
in-memory `Database`, imports a CSV and checks the inferred rows land
correctly, and exports a query to JSON and checks the file contents.

**This smoke test immediately caught a real, pre-existing, currently-live
bug**: `dot-commands.ts` queried a table named `sqlite_schema` for
`.tables` / `.schema`, but this SQL engine has no such table — it was never
implemented (confirmed via `packages/quereus/src/func/builtins/schema.ts`
and grep across `packages/quereus/src`). The correct mechanism is the
built-in `schema()` table-valued function. Both dot-commands ran into
`Table 'sqlite_schema' not found in schema path: main` and silently printed
an error line instead of listing/describing anything — so `.tables` and
`.schema` have been broken for every CLI user since this code was written.
Fixed both query sites (`SELECT ... FROM schema() ...` instead of `FROM
sqlite_schema`) as part of this ticket, since it's the exact surface the new
smoke test covers and the fix is a 3-line query change in the same file.
Also dropped a stray `await` on the (synchronous) `db.prepare(...)` call in
`importCsv` (pre-existing type-checker complaint, same method under test).

Updated the `//test` NOTE in `quoomb-cli/package.json` to describe what the
new spec actually covers, replacing the stale "no test files yet" text.
`--passWithNoTests` was left in place per the ticket's own guidance (not
removed just because a spec now exists).

**plugin-loader** — this is core plugin-loading infrastructure, not glue, so
an empty-green (or thin-green) here is the least defensible of the four. Read
through `src/plugin-loader.ts` and `src/config-loader.ts`: beyond the
existing config-channel spec, there is real untested logic — npm-spec
parsing (`parseNpmSpec`/`splitSubpath`/`splitVersion`), CDN URL construction,
the protocol-allowlist *rejection* path, environment-detection branching, and
`interpolateEnvVars`/`validateConfig`'s edge cases. Per the ticket's own
instruction, did **not** attempt to build that suite here — filed
`tickets/backlog/debt-plugin-loader-test-coverage.md` describing the
untested surface in the detail a future implementer needs, and updated the
`//test` NOTE in `package.json` to link it.

## Validation

- `yarn test` from repo root: full workspace run, **0 failures** (7000+
  tests across all packages, including the four here: quoomb-cli 4 passing,
  quoomb-web 74 passing, plugin-loader 3 passing, shared-ui 0 via
  `--passWithNoTests`).
- `yarn build` in `packages/quoomb-cli`: clean, no type errors (confirms the
  `sqlite_schema` → `schema()` fix and the `await` removal didn't break
  anything).
- `yarn lint` in the three non-quereus packages touched: all no-op
  (`echo 'No lint configured'`), as expected — only `packages/quereus` has a
  real lint/typecheck.

## Known gaps for the reviewer

- The quoomb-cli smoke spec is intentionally narrow (4 tests covering
  listTables/showSchema/importCsv/exportQuery). It does **not** cover the
  plugin subcommand dispatch (`.plugin install/list/enable/disable/remove/
  config/reload` in the same file) or `bin/quoomb.ts`'s config-resolution
  precedence (`--config` > `QUOOMB_CONFIG` env > cwd file > home dir file) —
  both are real logic that a future pass could reasonably extend coverage
  to, but weren't in scope for "cheap smoke insurance."
  NOTE: quoomb-cli's plugin subcommands and `resolveConfigPath` precedence
  are still unit-test-free; flagging here rather than filing a ticket since
  nothing currently indicates they're broken (unlike the `sqlite_schema` bug,
  which was actively wrong).
- The `sqlite_schema` bug fix was verified via the new smoke test
  (`listTables`/`showSchema` now return real rows against a live `Database`)
  and a clean `tsc` build, but not manually exercised through the actual
  `quoomb` REPL binary end-to-end — worth a quick manual `.tables`/`.schema`
  sanity check if reviewing this change closely.
- `debt-plugin-loader-test-coverage` (backlog) is a real, scoped-medium
  follow-up, not a tripwire — plugin-loader's untested surface (URL/npm-spec
  parsing, CDN resolution) is real logic today, not a future risk.
