----
description: Renamed MutationDiagnosticReason `tag-target-not-found` → `default-target-not-found` (raised only by the `insert defaults (col = expr, …)` unknown-column guard; no tag surface remains).
files:
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts   # union member renamed, tag-era parenthetical dropped
  - packages/quereus/src/planner/mutation/single-source.ts         # resolveDefaultForColumn doc comment + raise site
  - docs/view-updateability.md                                     # Diagnostics catalog entry, same comment cleanup
  - packages/quereus/test/quereus/view-mutation-substrate.spec.ts  # new reason-pinning test (appended describe block)
effort: low
----

# Rename `tag-target-not-found` → `default-target-not-found` — implemented

Pure rename of the machine-readable `reason` string; the human `message` text is
unchanged everywhere.

## What changed

- `mutation-diagnostic.ts` union member renamed; trailing comment now describes
  only the construct (dropped the false-after-rename "retained from the tag-era
  override surface" parenthetical).
- `single-source.ts` `resolveDefaultForColumn`: doc comment and the single
  `raiseMutationDiagnostic` site updated.
- `docs/view-updateability.md` Diagnostics catalog entry renamed, same
  parenthetical dropped.
- New mocha test in `view-mutation-substrate.spec.ts` ("insert defaults unknown
  column" describe block): plans `insert into dft_v values (1)` against a view
  with `insert defaults (nope = 1)` and asserts
  `mutationDiagnostic.reason === 'default-target-not-found'` plus the
  `names column 'nope'` message fragment — pins the machine-readable string
  that the sqllogic suite covers only by message.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean (TypeScript exhaustiveness
  is the completeness check for code raise sites).
- `yarn test` in packages/quereus — 5686 passing, 9 pending, 0 failures
  (includes 93.4 / 41.3 / 53.2 sqllogic suites, unchanged).
- Repo-wide grep for `tag-target-not-found` hits only `tickets/complete/`
  history (and the original ticket, now deleted).

## Review pointers

- Verify the new spec test asserts the right surface (plan-time
  `ViewMutationError` from `buildInsertStmt`, not runtime).
- Confirm no other docs outside `docs/view-updateability.md` catalog the reason
  string (grep was clean, but docs are not in the code-search index).
