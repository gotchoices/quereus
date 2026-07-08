description: The pre-release "check everything" command (`yarn check`) used to lint only one package and silently skip one package's tests; it now lints and tests every package, and the release command forces a real human confirmation instead of a 5-second pause.
files:
  - package.json (root — `lint` now fans out; `release` gated by scripts/release-guard.js)
  - scripts/release-guard.js (new — interactive pre-release confirmation)
  - packages/plugin-loader/package.json (added lint + test)
  - packages/quereus-isolation/package.json, quereus-store, quereus-sync, quereus-sync-client, sync-coordinator, quereus-plugin-indexeddb, quereus-plugin-leveldb, quereus-plugin-react-native-leveldb, quereus-plugin-nativescript-sqlite, sample-plugins (added lint)
  - packages/quoomb-cli/package.json, packages/shared-ui/package.json (added `//test` NOTE key)
  - AGENTS.md (Build & Test: lint-fan-out description refreshed)
difficulty: medium
----

## What this ticket did

`yarn check` is the project's only pre-release safety net (there is no CI, by
explicit product decision). It was lying: root `yarn lint` linted only
`@quereus/quereus`, and root `yarn test` silently skipped `plugin-loader`
(which had no `test` script — `yarn workspaces foreach ... run test` skips any
package lacking the script). A developer could see green and still ship broken
code from 15 other packages.

Changes made:

- **Lint fans out.** Root `lint` is now
  `yarn workspaces foreach -A --exclude quereus-workspace run lint`.
  Because `foreach` silently skips packages with no matching script, the 11
  packages that had no `lint` script each got one. None of those 11 has an
  eslint config (confirmed: only `packages/quereus/eslint.config.mjs` and the
  vscode client's `.eslintrc.json` exist), so each got the same intentional
  `echo 'No lint configured'` no-op already used by quoomb-cli/quoomb-web/
  shared-ui/quereus-vscode. `@quereus/quereus`'s real lint (eslint + `tsc -p
  tsconfig.test.json --noEmit`) is untouched and still runs first-class inside
  the fan-out.

- **Tests reach every package.** `plugin-loader` got a `test` script
  (`vitest run --passWithNoTests`) plus `vitest` in its devDependencies, so it
  is now *visible* to the fan-out instead of skipped. It has real source but no
  test files yet — flagged with a `//test` NOTE key.

- **Empty-test packages annotated.** `quoomb-cli` and `shared-ui` run
  `vitest run --passWithNoTests` with zero test files (green but empty). Both
  got a `//test` NOTE key so a future reader knows the green is unearned. Left
  as-is per ticket direction (they may be genuinely trivial). `quoomb-web` has
  real vitest tests (74) — untouched.

- **Release reminder hardened.** The old `release` script printed a message and
  paused 5s (`setTimeout(()=>{},5000)`) — trivially blown past. It is now gated
  by `scripts/release-guard.js`, which prints an unmistakable banner and blocks
  on an interactive prompt requiring the operator to type `yes`. Kept strictly
  local — no CI, no network. If stdin is not a TTY, it refuses (exit 1) rather
  than silently proceeding.

## How to validate

- **Lint reaches everything:**
  `yarn workspaces foreach -A --exclude quereus-workspace --verbose run lint`
  → every package name appears; 15 print `No lint configured` (one is `...for
  extension`), `@quereus/quereus` runs its real eslint+tsc silently. EXIT 0.
  (Plain `yarn lint` also works; verbose is only to see per-package names.)
- **Tests reach everything:**
  `yarn workspaces foreach -A --exclude quereus-workspace --verbose run test`
  → `[@quereus/plugin-loader]: No test files found, exiting with code 0`
  now appears (the exact package that used to be invisible). All 16 packages
  present; suites pass (quereus 6472, store 675, sync 429, sync-coordinator
  125, quoomb-web 74, etc.). EXIT 0.
- **No package lacks a script** (the core trap):
  grep each `packages/*/package.json` for `"lint":` and `"test":` — all 16
  have both. A one-liner is in the ticket log; re-run it to confirm.
- **Release guard:** `node scripts/release-guard.js` in a real terminal prompts
  and only proceeds on `yes`; piping non-TTY input aborts with exit 1.

## Known gaps / what the reviewer should push on

- **Release guard's `yes` (accept) path was NOT exercised** — this runner is
  non-TTY, so only the refuse-on-non-TTY branch ran. The accept logic is a
  trivial `answer.trim().toLowerCase() !== 'yes'` compare, but a human should
  run `yarn release` once in a real terminal to confirm the happy path (then
  Ctrl-C before it actually publishes). This is a test floor, not a ceiling.
- **Full `yarn check` was not run end-to-end.** I verified the two halves this
  ticket changed (`yarn lint`, `yarn test`) directly. `yarn build`,
  `yarn test:store`, and `yarn test:fork-strict` were left unrun: this ticket
  touches none of them (build is a separate explicit sequential list; store/
  fork-strict scripts are untouched), and a full check runs many minutes.
  A human/CI-free release run will exercise them.
- **`plugin-loader` / `quoomb-cli` / `shared-ui` green is empty, not earned** —
  `--passWithNoTests` with no test files. Acceptable per ticket, but these are
  real coverage gaps parked behind a NOTE, not resolved.
- **vitest for plugin-loader resolves via workspace hoisting.** vitest^4.0.17
  was added to plugin-loader devDependencies and `yarn install` succeeded
  (the install warnings printed are pre-existing peer-dependency noise, not
  from this change). The binary is hoisted to root `node_modules/.bin`.

## Tripwire (noticed, parked — not a ticket)

`yarn workspaces foreach ... run <script>` **silently skips any package lacking
that script** — this is the exact bug this ticket fixed for `lint`/`test`, and
it will re-bite any *future* fan-out script (`typecheck`, `doc`, `dep-check`
already use foreach and silently skip missing-script packages the same way). If
a new "run X everywhere" guard is added, every package must have script X or it
is invisibly omitted. Parked as this findings note (no single code site owns
it; it's a property of every foreach line in root package.json).

## Coordination note

Sibling ticket `test-add-missing-scripts` (implement/, sequence 3, runs after
this) does "mechanical script additions." This ticket already added `lint` to
all 11 packages and `test` to `plugin-loader`. When that ticket runs it should
find those done — it should not re-add them or fight this ticket's choices
(no-op echo for lint, `--passWithNoTests` for empty test packages). Deeper
test/build tooling lives in `test-coverage-and-build-tooling`.

## Review findings

- Verified `yarn lint` and `yarn test` fan out to all 16 packages (EXIT 0 each);
  `plugin-loader` now visible in test output. Release guard blocks non-TTY and
  requires typed `yes` in a TTY.
- **Gap:** release-guard accept path unexercised (non-TTY runner) — needs one
  human TTY run. See "Known gaps."
- **Gap:** full `yarn check` (build + test:store + test:fork-strict) not run;
  those paths are unchanged by this ticket. See "Known gaps."
- **Tripwire:** foreach silently skips packages missing the target script —
  applies to every current/future root fan-out script. Parked in "Tripwire"
  section above (no single code site).
