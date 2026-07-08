description: The pre-release "check everything" command (`yarn check`) used to lint only one package and silently skip one package's tests; it now lints and tests every package, and the release command forces a real human confirmation instead of a 5-second pause.
files:
  - package.json (root — `lint` fans out; `release` gated by scripts/release-guard.js)
  - scripts/release-guard.js (new — interactive pre-release confirmation)
  - packages/plugin-loader/package.json (added lint + test + vitest dep)
  - packages/*/package.json (11 packages: added `lint` no-op; quoomb-cli/shared-ui: `//test` NOTE)
  - agents.md (Build & Test: lint-fan-out description refreshed)
  - docs/releasing.md (Quick Release + checklist refreshed — review pass)
difficulty: medium
----

## What shipped

`yarn check` (`lint && build && test:full && test:fork-strict`) is the project's
only pre-release safety net — there is no CI, by explicit product decision. It
was lying twice: root `yarn lint` linted only `@quereus/quereus`, and root
`yarn test` silently skipped `plugin-loader` (no `test` script → `yarn
workspaces foreach ... run test` skips any package lacking the script). A green
`yarn check` could still ship broken code from 15 other packages.

Landed:

- **Lint fans out.** Root `lint` is now `yarn workspaces foreach -A --exclude
  quereus-workspace run lint`. The 11 packages that had no `lint` script each
  got an intentional `echo 'No lint configured'` no-op (none has an eslint
  config, so nothing to lint). `@quereus/quereus`'s real eslint+`tsc` lint is
  untouched and runs first-class inside the fan-out.
- **Tests reach every package.** `plugin-loader` got a `test` script
  (`vitest run --passWithNoTests`) plus `vitest` devDep, so it is visible to the
  fan-out instead of skipped. Real source, no test files yet — flagged `//test`.
- **Empty-test packages annotated.** `quoomb-cli`, `shared-ui` (and `plugin-
  loader`) run `--passWithNoTests` with zero test files; each got a `//test`
  NOTE so a future reader knows the green is empty, not earned.
- **Release reminder hardened.** Old `release` printed a message + 5s
  `setTimeout` — trivially blown past. Now gated by `scripts/release-guard.js`:
  prints a banner, blocks on an interactive prompt requiring a typed `yes`,
  refuses (exit 1) on a non-TTY stdin.

## Review findings

Adversarial pass over implement commit `faf9d307`. Ran lint + full test suite;
both green. Scrutinized fan-out coverage, release-guard logic, module system,
and every doc the change touches or should have.

**Checked — verified good:**
- **Lint fan-out reaches all 16 packages.** `yarn lint` → EXIT 0 in 28s; 15
  `No lint configured` echoes (one `...for extension`) + quereus's real
  eslint+tsc silent. Confirmed all 16 non-root packages have a `lint` script.
- **Test fan-out reaches all 16 packages.** `yarn test` → EXIT 0 in 4m10s.
  `plugin-loader` now appears in output (the package that used to be invisible);
  3 `No test files found` (plugin-loader, quoomb-cli, shared-ui); 12 mocha
  suites pass (quereus 6472, store 675, sync 429, sync-coordinator 125, …) +
  quoomb-web vitest 74. 12 mocha + 4 vitest = 16 packages, none skipped.
- **release-guard non-TTY path.** `node scripts/release-guard.js` under the
  non-interactive runner prints the banner and aborts with exit 1 as designed.
- **Module system.** Root `package.json` has no `"type"`, so `.js` = CommonJS;
  the guard's `require('readline')` loads fine (verified).
- **No other stale docs.** Grepped every `*.md` for lint/check/CI claims —
  only `docs/releasing.md` was stale (fixed, see below); `agents.md`,
  `architecture.md`, `runtime.md` already correct.

**Found + fixed inline (minor, docs):**
- `docs/releasing.md` was inconsistent with this ticket's whole premise. The
  checklist said "CI green on `main`" — there is no CI. Rewrote to "`yarn
  check` passes (there is no CI — this local run is the only pre-publish safety
  net)". Also refreshed the Quick Release paragraph, which described `yarn
  release` as just bump+pub, to name the new `release-guard.js` gate and the
  typed-`yes` confirmation.

**Known gaps (documented, not resolved — acceptable):**
- **release-guard accept (`yes`) path unexercised** — the runner is non-TTY, so
  only the refuse branch ran. Accept logic is a trivial `answer.trim().
  toLowerCase() !== 'yes'` compare. A human should run `yarn release` once in a
  real terminal (Ctrl-C before publish) to confirm the happy path. Not worth a
  ticket — 66-line local interactive script, trivial branch.
- **Full `yarn check` not run end-to-end.** The two halves this ticket changed
  (`yarn lint`, `yarn test`) were verified directly. `yarn build`,
  `yarn test:store`, `yarn test:fork-strict` are unchanged by this ticket and a
  full check runs many minutes; deferred to a human/release run.
- **plugin-loader / quoomb-cli / shared-ui green is empty, not earned**
  (`--passWithNoTests`, no test files). Real coverage gaps parked behind
  `//test` NOTEs; deeper test tooling lives in sibling
  `test-coverage-and-build-tooling`.

**Tripwires (conditional — parked, not tickets):**
- `yarn workspaces foreach ... run <script>` **silently skips any package
  lacking that script** — the exact trap this ticket fixed for `lint`/`test`.
  `typecheck`, `doc`, `dep-check`, and `test:all` already use foreach and skip
  missing-script packages the same way. Any *future* "run X everywhere" guard
  must add script X to every package or it is invisibly omitted. No single code
  site owns this; it is a property of every foreach line in root
  `package.json`. Parked here (index) + carried by the implement handoff.
- **`agents.md` filename case.** The repo tracks the root instructions file as
  lowercase `agents.md`, but `CLAUDE.md` imports it as `@AGENTS.md`. Both
  resolve on the case-insensitive Windows/macOS filesystem in use; a
  case-sensitive checkout (Linux) would fail the import. Pre-existing (predates
  this ticket — the diff edited the existing tracked `agents.md`), and there is
  no Linux/CI checkout in play, so left as-is. If the project ever adds a
  Linux CI or case-sensitive build, rename or fix the import.

## Coordination note

Sibling `test-add-missing-scripts` (implement/, seq 3) does "mechanical script
additions." This ticket already added `lint` to all 11 packages and `test` to
`plugin-loader`; that ticket should find them done and not re-add or fight these
choices (no-op echo lint, `--passWithNoTests` for empty test packages).
