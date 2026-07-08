description: Checked that every package in the workspace has the test and lint commands needed so the "run everything" commands actually reach it, after an earlier ticket already made those additions — nothing new to change, just confirmed the fix holds.
files:
  - packages/plugin-loader/package.json (test script present: vitest run --passWithNoTests)
  - packages/quereus-isolation/package.json (lint present: echo no-op)
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

## What happened

This ticket's whole job — give every package a `test` and `lint` script so
`yarn workspaces foreach ... run <script>` can reach it instead of silently
skipping it — was already done by the prereq ticket
`test-yarn-check-runs-everything` (now in `tickets/complete/`). Its own
coordination note called this out explicitly: "this ticket already added
`lint` to all 11 packages and `test` to `plugin-loader`; [the successor]
should find them done and not re-add or fight these choices."

Checked all 11 files listed in this ticket's `files:` header directly — every
one already has both scripts:
- `plugin-loader`: `"test": "vitest run --passWithNoTests"`, with a `//test`
  NOTE comment flagging the green as empty (no spec files yet).
- All 11: `"lint": "echo 'No lint configured'"` (no eslint config applies to
  any of them — matches the `quoomb-web`/`quoomb-cli`/`shared-ui`/
  `quereus-vscode` precedent from `2-quoomb-web-lint-no-eslint-config`).

No code changes made in this pass — there was nothing left to add.

## Verification performed

- `yarn lint` (root fan-out `yarn workspaces foreach -A --exclude
  quereus-workspace run lint`): exit 0 in ~28s. 15 `No lint configured`
  echoes (one package logs "for extension" variant) + `@quereus/quereus`'s
  real eslint+tsc lint runs silently alongside (no separate echo — it's the
  one package with a real lint config). 15 + 1 = 16, matching every non-root
  workspace package (17 dirs under `packages/` minus `tools/`, which has no
  `package.json` and isn't a yarn workspace).
- `yarn test` (root fan-out `yarn workspaces foreach -A --exclude
  quereus-workspace run test`): exit 0 in ~3m22s. `plugin-loader` appears in
  the output (`RUN v4.1.9 .../plugin-loader` → `No test files found, exiting
  with code 0`) instead of being silently absent. Three packages report "No
  test files found" (`plugin-loader`, `quoomb-cli`, `shared-ui` — all
  intentional, all NOTE'd); the rest run real mocha/vitest suites and all
  pass (quereus, isolation, store, sync, sync-client, sync-coordinator,
  sample-plugins, indexeddb, leveldb, react-native-leveldb,
  nativescript-sqlite via mocha; quoomb-web via vitest).

## Known gaps (unchanged from prereq ticket, not re-litigated here)

- `plugin-loader` / `quoomb-cli` / `shared-ui` green is empty
  (`--passWithNoTests` / no spec files) — real coverage is out of scope for
  this mechanical-script ticket, tracked separately.
- The 11 packages' `lint` scripts are intentional no-ops, not real linting —
  standing up real eslint configs for them is a separate, larger investment
  (deliberately deferred per the `quoomb-web` precedent ticket).
- `yarn build`, `yarn test:store`, `yarn test:fork-strict` (the rest of
  `yarn check`) were not re-run here — out of scope, unchanged by this
  ticket or its prereq.

## For the reviewer

Nothing to adversarially review code-wise (no diff produced by this ticket).
Worth spot-checking: that the prereq ticket's `files:` claim and this
ticket's `files:` list genuinely refer to the same 11 packages + plugin-loader
(they do — cross-checked by hand above), and that no package was missed by
either ticket. All 16 non-root workspace packages were enumerated and
confirmed reachable by both `yarn lint` and `yarn test` in this pass.
