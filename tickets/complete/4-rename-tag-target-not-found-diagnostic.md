----
description: Renamed MutationDiagnosticReason `tag-target-not-found` → `default-target-not-found` (raised only by the `insert defaults (col = expr, …)` unknown-column guard; no tag surface remains). Reviewed and complete.
files:
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts   # union member renamed, tag-era parenthetical dropped
  - packages/quereus/src/planner/mutation/single-source.ts         # resolveDefaultForColumn doc comment + raise site
  - docs/view-updateability.md                                     # Diagnostics catalog entry, same comment cleanup
  - packages/quereus/test/quereus/view-mutation-substrate.spec.ts  # new reason-pinning test (appended describe block)
----

# Rename `tag-target-not-found` → `default-target-not-found` — complete

Pure rename of the machine-readable `reason` string raised by the
`insert defaults (col = expr, …)` unknown-column guard; the human `message`
text is unchanged everywhere. Union member, raise site, doc comment, and the
`docs/view-updateability.md` Diagnostics catalog were all updated, and a new
mocha test pins the renamed `reason` string at plan time.

## Review findings

Reviewed the implement diff (`d82a27ac`) fresh, then validated the handoff
claims independently.

**Checked:**
- Diff read line-by-line: all four production touch points (union member,
  raise site, `resolveDefaultForColumn` doc comment, docs catalog) renamed
  consistently; the now-false "retained from the tag-era surface" parentheticals
  dropped in both the union comment and the docs catalog. Human `message` text
  untouched, as required by the sqllogic message-pinning tests.
- Stale-name grep: `tag-target-not-found` hits only `tickets/complete/`
  history (and this ticket chain) — no source, test, or doc leakage.
- New-name grep: `default-target-not-found` appears exactly in the four
  expected files.
- Docs sweep (per the review pointer): grepped all `*.md` for
  `MutationDiagnostic`/reason-string catalog content — `docs/view-updateability.md`
  is the only doc cataloging the reason union; no other doc needed updating.
- New spec test: verified it asserts the right surface — it calls
  `buildInsertStmt` directly (plan time, not runtime), catches
  `ViewMutationError`, and pins both `mutationDiagnostic.reason` and the
  `names column 'nope'` message fragment. All imports it relies on already
  existed at the top of `view-mutation-substrate.spec.ts`.
- TypeScript exhaustiveness: the string-literal union means any missed raise
  site is a compile error; lint (which type-checks) passed clean.
- `yarn lint` in packages/quereus — exit 0.
- `yarn test` in packages/quereus — 5686 passing, 9 pending, 0 failures
  (includes the 93.4 / 41.3 / 53.2 sqllogic suites and the new spec test).

**Found:** nothing. The change is a minimal, self-consistent rename with the
exact scope the plan called for; no minor fixes were needed and no major
findings warranted new tickets.

**Done:** no code changes in this pass; ticket archived to complete.
