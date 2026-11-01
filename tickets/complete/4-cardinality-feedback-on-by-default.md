description: Cardinality feedback (the planner remembering exact table sizes it sees while running queries) is now on by default, after measuring that it costs nothing noticeable and finding no test or benchmark whose plan changed.
prereq: cardinality-feedback-commit-scoped-publication, cardinality-feedback-replan, cardinality-feedback-diagnostics
architecture: docs/progressive-optimizer.md#38-overhead-budget-and-how-it-is-verified
files: packages/quereus/src/core/database.ts, docs/usage.md, docs/progressive-optimizer.md, docs/sql-txn.md
difficulty: easy
----

# Complete: `cardinality_feedback` on by default

Last of the `cardinality-feedback-*` chain. `cardinality_feedback` option's `defaultValue` flipped `false` → `true` in `Database` (`src/core/database.ts`); the stale "default off until…" comment was trimmed to the part that still holds. Docs updated: `docs/usage.md` option row, `docs/progressive-optimizer.md` (status, §3.7 determinism and benchmark gate, §3.8 verification), `docs/sql-txn.md` §9.5.

Implement-stage evidence (`ticket(implement): cardinality-feedback-on-by-default`): flip-alone execution benchmark against its parent build showed 0 regressions and every scan-heavy row inside its noise floor, all 30 work-counter sets identical; `yarn bench:gate` 56 match / 0 differ, no reference re-baselined; `yarn test`, `test:store`, the three strict variants and every workspace's tests passing with unchanged counts. Nothing moved because every SQL benchmark table holds ≤ 10,000 rows (`spread(10000, 1000) ≈ 9.99 < 10`) and the sqllogic corpus tops out at 200 rows (below the 1000-row record floor).

## Review findings

- **Code diff** — one constant and a comment trim. Checked the gate (`Database` per-execution sink creation reads the option at each execution) so the default applies with no pragma; the implementer's 20,000-row sanity check confirms observation happens by default. No issues.
- **Docs** — grepped every `cardinality_feedback` / "cardinality feedback" mention across `docs/`, package READMEs and `src/`: no remaining "off by default" claims. `docs/functions.md` ("empty while the option is off") and `docs/optimizer.md` remain accurate. One minor imprecision fixed inline: `docs/usage.md` said "only tables larger than 1000 rows are remembered", but the record rule is `max(before, n) > minRows`, so a previously-large table that shrank is also recorded — reworded to "larger than 1000 rows (as observed, or as previously estimated)". `yarn docs:check` OK.
- **Tests** — none added, none cut. A test pinning a default constant fails the testing bar. The feedback specs' explicit `pragma cardinality_feedback = true` lines are now redundant but keep those specs independent of the default; left in place. Re-ran the feedback-related specs (`node test-runner.mjs --grep ardinality`): 43 passing. Full suites were run by the implementer with unchanged counts; not re-run for a doc-only review edit.
- **Determinism / interactions** — feedback now applies in every embedding (CLI, web, sync, coordinator). Bounded memory (`maxTables` 512, LRU) and the 1000-row floor / 10× shift rule limit plan variation to large never-analyzed or stale tables; the reproducible-plans escape hatch is documented in `usage.md` and §3.7. No action.
- **Performance** — re-plan cost is not exercised by any benchmark (no workload crosses the shift threshold); already documented in §3.8 as bounded by the cooldown. Considered and left as-is: adding a shifting benchmark is new scope, not a defect.
- **Store-pass `[TransactionCoordinator] … savepoint depth … out of range` warnings** noted by the implementer — logged warnings, not failures, from a path this ticket does not touch; not investigated here, nothing filed.
- **Error handling / resource cleanup / type safety** — no new code paths; nothing to check beyond the existing chain (reviewed in the prior `cardinality-feedback-*` reviews).
