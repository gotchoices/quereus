description: Several packages are missing the standard test and lint commands, so the workspace-wide "run tests" and "run lint" commands silently skip them; add the missing commands so every package is at least reachable by the workspace runner.
prereq: test-yarn-check-runs-everything
files:
  - packages/plugin-loader/package.json (no test script)
  - packages/quereus-isolation/package.json
  - packages/quereus-store/package.json
  - packages/quereus-sync/package.json
  - packages/quereus-sync-client/package.json
  - packages/sync-coordinator/package.json
  - packages/quereus-plugin-indexeddb/package.json
  - packages/quereus-plugin-leveldb/package.json
  - packages/quereus-plugin-react-native-leveldb/package.json
  - packages/quereus-plugin-nativescript-sqlite/package.json
  - packages/sample-plugins/package.json
difficulty: easy
----

## Problem

The workspace-wide `yarn test` and `yarn lint` use
`yarn workspaces foreach … run <script>`, which **silently skips** any package that
does not define that script. So packages missing a script are invisible to the
workspace runner — no error, just absence. Concretely:

- **No `test` script**: `plugin-loader` — never run by `yarn test`.
- **No `lint` script** (11 packages): `plugin-loader`, `quereus-isolation`,
  `quereus-store`, `quereus-sync`, `quereus-sync-client`, `sync-coordinator`,
  `quereus-plugin-indexeddb`, `quereus-plugin-leveldb`,
  `quereus-plugin-react-native-leveldb`, `quereus-plugin-nativescript-sqlite`,
  `sample-plugins`.

This is the mechanical half of making `yarn check` cover everything. The root-level
wiring (switching root `yarn lint` to a foreach, hardening the release reminder) is
in `test-yarn-check-runs-everything`; this ticket just makes sure every package has
the scripts that foreach needs to reach it. Split out so the two can land without
stepping on each other — coordinate so the same script isn't added twice.

## Expected outcome

Every package defines both a `test` and a `lint` script, so
`yarn workspaces foreach … run test` and `… run lint` reach all of them. A package
with genuinely nothing to run has an **explicit** placeholder (a `--passWithNoTests`
test or an `echo 'No lint configured'` lint, matching the existing precedent) — so
its emptiness is visible and intentional, never a silent skip.

## Direction

- **`plugin-loader` test script**: add one. Real if it has anything testable;
  otherwise an explicit `--passWithNoTests`-style placeholder with a `NOTE:` that
  the green is empty. Do not leave it script-less.
- **Missing `lint` scripts (the 11 packages)**: add a `lint` script to each. Use a
  real eslint invocation only where an eslint config actually applies to that
  package; otherwise the same intentional `echo 'No lint configured'` no-op already
  used by `quoomb-cli` / `quoomb-web` / `shared-ui` / `quereus-vscode` (see
  completed ticket `2-quoomb-web-lint-no-eslint-config` for that precedent and why
  real React/TS lint configs were deliberately deferred). Standing up *real* linting
  for these packages is a separate human-sign-off investment — out of scope here;
  the goal is only that no package is silently unreachable.

## Edge cases

- Do not touch `@quereus/quereus`'s real lint (eslint + `tsc` on test files) — it
  stays first-class.
- Windows lint globs must be single-quoted (AGENTS.md) if any real eslint script is
  added.
- After adding, run the workspace `foreach … run lint` / `run test` and confirm all
  packages appear.

## TODO

- Add a `test` script to `plugin-loader` (real or explicit placeholder + `NOTE:`).
- Add a `lint` script to each of the 11 packages listed in `files:` (real where a config applies, else intentional no-op echo).
- Run workspace foreach test + lint and confirm every package is now reached.
