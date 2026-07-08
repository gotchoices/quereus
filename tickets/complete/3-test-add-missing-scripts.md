description: Confirmed every workspace package has the test and lint commands the "run everything" commands need — the earlier ticket's fix holds, reviewer re-ran both and found nothing to change.
files:
  - packages/plugin-loader/package.json
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

## Summary

This ticket's job — give every workspace package `test` + `lint` scripts so
`yarn workspaces foreach ... run <script>` reaches them instead of silently
skipping — was already delivered by prereq `test-yarn-check-runs-everything`
(in `tickets/complete/`). The implement pass produced **no code diff** (commit
`174f394f` moves only the ticket file). Review re-verified the claim from
scratch and confirmed it holds. No inline fixes made — nothing to change.

## Review findings

**What was checked:**

- **Every workspace `package.json`, script presence** — enumerated all 16
  non-root packages via `require('./<pkg>/package.json').scripts`. Every one
  has both a `test` and a `lint` script. No package missed by the prereq.
  - `plugin-loader` / `quoomb-cli` / `quoomb-web` / `shared-ui`:
    `test = vitest run --passWithNoTests`.
  - All mocha packages (quereus-store, -sync, -sync-client, -isolation,
    sync-coordinator, sample-plugins, the 4 storage plugins, quereus-vscode):
    real mocha `test` scripts.
  - `@quereus/quereus`: real `test` (`node test-runner.mjs`) + real `lint`
    (`eslint … && tsc -p tsconfig.test.json --noEmit`).
  - All non-quereus packages: `lint = echo 'No lint configured'` (vscode:
    `…for extension` variant) — intentional no-ops per the `quoomb-web`
    precedent, not real linting.
- **`yarn lint` fan-out** — exit 0 in ~29s. 16 packages reached (15
  `No lint configured` echoes + `@quereus/quereus`'s real eslint+tsc running
  silently). Matches the 16 non-root workspace packages.
- **`yarn test` fan-out** — exit 0 in ~3m42s. `plugin-loader` now appears in
  output (`RUN … plugin-loader → No test files found, exiting with code 0`)
  instead of being absent. Real suites all green: quereus 6473 passing,
  quoomb-web 74, plus store/sync/sync-client/isolation/sync-coordinator/
  sample-plugins/indexeddb/leveldb/react-native-leveldb/nativescript-sqlite
  mocha suites. Three intentional empty-greens (`plugin-loader`, `quoomb-cli`,
  `shared-ui` — `--passWithNoTests`, all NOTE-flagged in prereq).
  - Note: test logs contain many `Error:`/`[Sync]`/`[StoreModule]`-shaped
    lines (`boom`, `bookkeeping-bug`, `batch write failed`,
    `hash drifted out-of-band`, etc.). These are **intentional negative-path
    test fixtures** exercising error handlers — every suite still reports
    passing and the fan-out exits 0. Not defects.

**Correctness / edge cases / regressions:** No code diff to review
adversarially — none possible. The mechanical claim (all packages reachable
by both fan-outs) was the whole deliverable and is verified true by direct
re-run of both commands.

**Findings requiring action:** None. No inline fixes, no new tickets, no
tripwires. The empty-green packages and no-op lints are known, deliberate, and
tracked out of scope for this mechanical-script ticket (see *Known gaps*
below) — not new findings.

## Known gaps (inherited, out of scope — not re-litigated)

- `plugin-loader` / `quoomb-cli` / `shared-ui` greens are empty
  (`--passWithNoTests` / no spec files). Real coverage is a separate concern.
- The no-quereus packages' `lint` scripts are intentional `echo` no-ops, not
  real eslint. Standing up real eslint configs is a separate, larger
  investment, deliberately deferred per the `quoomb-web` precedent.
- `yarn build`, `yarn test:store`, `yarn test:fork-strict` (rest of
  `yarn check`) not re-run here — unaffected by this ticket or its prereq.
