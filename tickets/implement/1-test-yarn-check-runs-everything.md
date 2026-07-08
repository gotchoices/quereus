description: The single "check everything before release" command only lints one of the project's packages and skips one package's tests entirely, so a developer can run it, see green, and still ship broken code from the other packages; make that command actually cover every package.
files:
  - package.json (root — scripts: check, lint, test, test:full, release)
  - packages/quereus/package.json (only real lint script)
  - packages/quoomb-cli/package.json
  - packages/quoomb-web/package.json
  - packages/shared-ui/package.json
  - packages/quereus-vscode/package.json
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
difficulty: medium
----

## Problem

The project has no continuous-integration server. By explicit product decision it
is **not** getting one: the safety net is a single command, `yarn check`, that a
developer is expected to run before publishing, plus a reminder printed by
`yarn release`. That makes it essential that `yarn check` genuinely runs
*everything*. Today it does not.

`yarn check` (root `package.json`) is:

```
yarn lint && yarn build && yarn test:full && yarn test:fork-strict
```

Two holes:

### 1. Lint covers only one package

Root `yarn lint` is `yarn workspace @quereus/quereus run lint`. It lints **only**
`@quereus/quereus`. Current state of `lint` scripts across the workspace:

- **Real lint** (eslint + `tsc -p tsconfig.test.json --noEmit`): `packages/quereus` only.
- **No-op echo** (`echo 'No lint configured'`): `quoomb-cli`, `quoomb-web`,
  `shared-ui`, and `quereus-vscode` (`…for extension`). These are intentional
  placeholders — see completed ticket `2-quoomb-web-lint-no-eslint-config`, which
  deliberately chose no-op echoes over standing up real React/TS eslint configs
  (that remains a separate, human-sign-off investment, out of scope here).
- **No `lint` script at all** (11 packages): `plugin-loader`, `quereus-isolation`,
  `quereus-store`, `quereus-sync`, `quereus-sync-client`, `sync-coordinator`,
  `quereus-plugin-indexeddb`, `quereus-plugin-leveldb`,
  `quereus-plugin-react-native-leveldb`, `quereus-plugin-nativescript-sqlite`,
  `sample-plugins`.

So even a package that *has* a lint script (the four no-op ones) is never invoked
by `yarn check`, and 11 packages have nothing to invoke.

### 2. Tests skip one package silently

Root `yarn test` is `yarn workspaces foreach -A --exclude quereus-workspace run test`.
`foreach … run test` **skips any package that has no `test` script** — so
`plugin-loader` (no `test` script) is never run by `yarn check` and nobody is told.
Additionally `quoomb-cli` and `shared-ui` use `vitest run --passWithNoTests` but
ship **no test files**, so they exit green while testing nothing. (`quoomb-web`
does have real vitest tests; leave it.)

`test:full` = `yarn test && yarn test:store`, so the store re-run is covered; the
gap is specifically plugin-loader being invisible and the two empty vitest packages.

## Expected outcome

Running `yarn check` from the repo root:

- Runs **every** package's lint script. Every package either has a real lint
  script or an explicit, intentional no-op echo — no package is silently
  un-lintable, and none is silently skipped by the root command.
- Runs **every** package's tests, or fails loudly for any package that has no
  test coverage rather than skipping it silently. At minimum, no package is
  invisibly omitted the way `plugin-loader` is today.
- The `yarn release` command still reminds the developer to run `yarn check`
  first, and that reminder is hard to miss.

Do **not** add any `.github` directory, GitHub Actions workflow, or other CI
server. The reminder stays a reminder — a human runs `yarn check`.

## Direction

**Lint everything.** Make root `yarn lint` fan out across the workspace instead of
targeting one package. Follow the existing pattern used by root `test` / `build` /
`typecheck` (`yarn workspaces foreach -A --exclude quereus-workspace run lint`),
but note that `foreach … run lint` silently skips packages with no `lint` script —
the same trap as tests. So the two halves are coupled: give **every** package a
`lint` script first (real where an eslint config already applies, otherwise the
same intentional `echo 'No lint configured'` no-op already used by four packages),
then switch root `lint` to the foreach form. Enumerate the 11 packages listed
above and give each one a `lint` entry so the fan-out reaches all of them. Keep
`@quereus/quereus`'s real lint intact and first-class.

**Test everything, or fail loudly.** Give `plugin-loader` a `test` script — a real
one if it has anything testable, otherwise an explicit `vitest run --passWithNoTests`
(or equivalent) so it is *present and visible* rather than skipped by `foreach`.
Decide whether `quoomb-cli` and `shared-ui` shipping zero test files behind
`--passWithNoTests` is acceptable; if it is (they may be genuinely trivial), leave
a `NOTE:` at the script so a future reader knows the green is empty, not earned.
Do not paper over the plugin-loader gap by leaving it script-less.

**Strengthen the release reminder.** The current `release` script prints a message
then `setTimeout(()=>{},5000)` — a 5-second pause a developer blows past without
reading. Make the reminder harder to ignore: e.g. require an explicit confirmation
step, or gate `release` behind having actually run `yarn check`, or at least make
the pause and message unmistakable. Keep it a *local* guard — no CI, no network,
no external gate.

**Verify the fan-out actually fans out.** After wiring, run `yarn lint` and confirm
it visibly executes in every package (not just quereus), and run `yarn test` and
confirm plugin-loader appears in the output. A green run that silently skipped a
package is the exact failure this ticket exists to remove.

## Edge cases & interactions

- `foreach` skip-on-missing-script is the core trap — the fix is only real if every
  package that should be reached actually *has* the script. Grep the final state to
  confirm no package lacks `lint` or `test`.
- Overlaps with `test-coverage-and-build-tooling` (deeper test/build-tooling work)
  and `test-add-missing-scripts` (mechanical script additions) — this ticket owns
  the `yarn check` fan-out specifically; coordinate so the missing-script additions
  aren't done twice. If `test-add-missing-scripts` lands first, this ticket only
  needs the root `lint` foreach switch and the release-reminder hardening.
- Windows lint globs must be single-quoted (see AGENTS.md) to avoid
  command-line-too-long — preserve that in any new lint script.
- Don't let the real `@quereus/quereus` lint (which also type-checks test files) get
  demoted or its `tsc` pass dropped when generalizing the root script.

## TODO

- Add a `lint` script to each of the 11 packages currently missing one (real eslint
  where a config applies; intentional `echo 'No lint configured'` no-op otherwise).
- Switch root `yarn lint` to `yarn workspaces foreach -A --exclude quereus-workspace run lint`.
- Add a `test` script to `plugin-loader` (real, or explicit `--passWithNoTests` with a `NOTE:`).
- Decide + annotate the `quoomb-cli` / `shared-ui` empty-vitest situation (leave `NOTE:` if kept).
- Harden the `yarn release` reminder from the weak 5s `setTimeout` into something a developer can't blow past, while keeping it a local reminder (no CI).
- Run `yarn lint` and `yarn test` and confirm every package appears in the output; then run full `yarn check`.
