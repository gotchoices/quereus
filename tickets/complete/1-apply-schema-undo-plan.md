description: When the engine works out the steps needed to bring a database in line with a declared schema, it now also works out how to take each step back again, so a later change can restore the database when a migration fails partway.
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/schema/schema-differ.ts            # MigrationStep.undo / .irreversible; generateMigrationPlan(diff, schemaName, actual); UndoRenderer + helpers (bottom of file)
  - packages/quereus/src/schema/catalog.ts                  # three optional fields: namedConstraints[].bodyAst, maintained.columns, CatalogView.columns
  - packages/quereus/src/schema/catalog-rendering.ts        # the three new fields destructured-and-ignored (compiler-enforced arms)
  - packages/quereus/src/schema/ddl-generator.ts            # schemaConstraintToTableConstraint exported for the catalog
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # 44 cases (40 from implement + 4 from review)
  - packages/quereus/test/schema/catalog.spec.ts            # one assertion projects bodyAst out of a namedConstraints deep-equal
  - docs/schema-undo-plan.md                                # new satellite doc (review moved § Undo plan here; schema.md was over the docs word cap)
  - docs/schema.md                                          # MigrationStep bullet; topic-table row and stub pointing at the satellite
  - docs/schema-rename-detection.md                         # pointer to the satellite
  - docs/.stability.json                                    # the satellite registered as Beta
  - packages/quereus/README.md                              # docs index: the satellite added to the Schema Management deep dives
  - tickets/backlog/debt-oversized-source-files.md          # schema-differ.ts re-measured; the UndoRenderer block named as the first cut
  - tickets/implement/2-apply-schema-rollback-journal.md    # ViewSchema.sql instability arm (appended during implement)
difficulty: hard
----
# Record how to undo each migration step — complete

## What landed

`generateMigrationPlan(diff, schemaName?, actual?)` takes the pre-apply `SchemaCatalog` as an optional third argument. With it, every `MigrationStep` carries either `undo: readonly string[]` (the statements that put the catalog back, in execution order; `[]` when the step changed nothing) or `irreversible: string` (a user-readable reason). Without it nothing about the undo is computed and `diff schema` output is byte-identical to before.

A single `UndoRenderer` class at the bottom of `schema-differ.ts` renders each step's undo at the step's own push site. It is told about renames as their steps land and reads the pre-apply catalog through the renames in force at that step, which is what makes the two correctness rules hold: spell the target as the forward step did, and forward-apply the preceding renames to any catalog-sourced body. Exactly three steps are irreversible, the data-destroying ones (`DROP TABLE`, `DROP COLUMN`, `SET DATA TYPE`), gated on the target existing in the pre-apply catalog.

The catalog grew three optional fields (`namedConstraints[].bodyAst`, `maintained.columns`, `CatalogView.columns`) so restores render from structured ASTs rather than re-parsing catalog DDL text; only the index arm re-parses, because the catalog carries no structured index shape. See `docs/schema.md` § Undo plan for the full per-step table and the deliberate deviations from the original ticket text (preceding-renames-only, the reshape leg composing back, `SET DEFAULT` after a stale-default clear undoing to `DROP DEFAULT`).

## Review findings

**Checked.** The implement diff was read end to end before the handoff summary. Every arm of `UndoRenderer` was walked against the two rules, with particular attention to: lookups under a table rename plus a same-plan create of the vacated name; column renames in one table's alter block versus constraint drops in another's; the FK parent under a table and column rename; the maintained-table detach / attach / reshape leg; index re-parse through `applyIndexDefaults` under a non-main schema. Also checked against the live engine: the rename propagation in `alter-table.ts` never rewrites a maintained derivation body, so replaying table renames onto the catalog body is the correct undo regardless (Rule 2 does not depend on what the live propagation does); `create view` binds late (no source validation at create), so the reverse-order unwind of view drops cannot fail on a view-on-view dependency; `drop view` refuses when an assertion or a table expression depends on it, and assertion drops are the plan's first steps, so the reverse-order undo recreates the view before the assertion; `CreateAssertionStmt` carries no tags, so the assertion restore loses nothing. Every doc the change touches (`docs/schema.md`, `docs/schema-rename-detection.md`) and the ones that mention the planner (`docs/materialized-views.md`) were read; they reflect the new reality.

**Found and fixed inline (minor).**

- A name vacated by a rename in force (rename `a` to `b`, then create a fresh `a` in the same plan; likewise a column `x` renamed to `y`) resolved to the *old* object in `tableNow` / `columnNow` / `constraintNow`, so a catalog-sourced undo on the new object would have restored the old one's state. Not reachable through today's differ (it never alters a freshly created object), so a latent trap rather than a live bug. Fixed with one shared `preRenameName` helper that returns "no pre-apply object" for a vacated name; pinned by a hand-built-diff test.
- `setMaintainedFrom` took the whole table and dereferenced `maintained!`; it now takes the derivation descriptor, and the non-null assertion is gone. `undoSetMaintained` took a redundant `schemaPrefix` parameter the renderer already holds.
- `replayRenames` communicated "how many column renames have been replayed so far" to the column resolver through a mutable instance field (`replayed`). Replaced with a per-step closure (`columnResolverAfter(n)`), so the resolver's world is explicit in its construction and no hidden state survives between calls.
- Tests added for the three gaps the handoff named: the non-owning (`'foreign'`) CHECK walk under another table's column rename (exact undo text and an executed round trip), `view.select` / `maintained.select` absent reporting `irreversible` with the reason, and the vacated-name rule above. Spec is now 44 cases.

**Evidence appended to an existing ticket.** `schema-differ.ts` is now 3,663 lines (`wc -l`, 2026-09-24; up ~480 from this work). It is already on `debt-oversized-source-files`; that ticket's header and its `schema-differ.ts` section were updated with the new count and with the `UndoRenderer` block named as the cleanest first extraction, including the value-import cycle a `schema/migration-undo.ts` would have to avoid. Not extracted here: the cycle makes it more than a mechanical move.

**Tripwires.** No new ones. The two the implementer left stand as written: the index map keyed by bare name (first entry wins, matching the plan's bare `DROP INDEX`; `NOTE:` in the `UndoRenderer` constructor) and the eager per-step render (`NOTE:` on the class doc; render lazily if plan generation ever shows in profiles).

**Considered, not filed.**

- `cannotUndo` warn-logs at plan time even for hand-built partial catalogs. Acceptable: it fires only when a restore is impossible, which is worth a log line, and the tests that provoke it are few.
- `generateMigrationPlan` still reads the create buckets without `?? []`, unchanged from before this ticket; the tolerance the ticket asked for was on the alter sub-buckets and catalog lookups, both present.
- Multi-statement undo has a type and an executor contract but no producer. Nothing to do until an arm needs it.
- The `ViewSchema.sql` instability under rename (the round-trip helper blanks view `ddl` to work around it) is a pre-existing drift already recorded as an arm on `apply-schema-rollback-journal`, where the fingerprint compare that it affects lives. Not re-filed.

**Docs gate (found and fixed).** The implement stage did not run `yarn docs:check`. It reported two failures from this ticket: a dead anchor in the new § Undo plan (`#…-dropadd` where the heading slug is `#…-droprecreate`), and `docs/schema.md` pushed over the 12,000-word cap (11,422 words before the implement commit, 12,321 after). Fixed by moving § Undo plan into its own satellite, `docs/schema-undo-plan.md` (Beta, registered in `docs/.stability.json`, listed in the hub's topic table and the package README), leaving the usual one-line stub under the original heading; `schema.md` is back to 11,479 words. The gate's third failure, `docs/usage.md` over the cap, predates this ticket (same count at HEAD and HEAD~1; last edited by `exec-batch-as-one-transaction`) and is reported in `tickets/.pre-existing-error.md` for triage.

**Validation.** `yarn lint` clean (eslint plus the test-file type check). `yarn workspace @quereus/quereus test`: 10,701 passing, 25 pending (the 4 new cases on top of the 10,697 the handoff reported). `node scripts/check-docs.mjs`: only the pre-existing `docs/usage.md` failure remains.
