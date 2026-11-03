description: On a storage backend that cannot change a primary key in place, an "apply schema" that rebuilt a table and then failed on anything later left the table empty while reporting an ordinary failure. The apply now refuses the rebuild unless it is the only thing the apply does.
architecture: docs/schema-undo-plan.md#a-primary-key-rebuild
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # rebuildWouldBeOnlyEffect, refuseCertainRebuild, the flag held around runBatchedMigrationLoop
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAlterPrimaryKey refusal; assertModuleCanRebuild extracted and exported
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # rebuildNotOnlyEffectError, the one shared error
  - packages/quereus/src/core/database.ts   # _setPrimaryKeyRebuildRefused / _isPrimaryKeyRebuildRefused
  - packages/quereus/src/vtab/module.ts   # endSchemaBatch contract: the cost of defining the hook
  - packages/quereus/test/no-alter-module.ts   # declineAlterPrimaryKey option
  - packages/quereus/test/apply-schema-restore.spec.ts   # the coverage
  - docs/schema.md   # § Failure and restoration
  - docs/schema-undo-plan.md   # § A primary-key rebuild
  - docs/module-authoring-schema-changes.md   # refusal list
  - docs/sql-alter.md   # precondition list
repro: verified
difficulty: medium

# Committed rows were lost when a rebuilt primary key's apply failed

A backend that cannot re-key in place changes a primary key through the engine's rebuild: create a hidden copy, copy the rows, drop the original, rename the copy over it. The drop and rename survive a rollback; the row copy does not. An `apply schema` in autocommit runs in one implicit transaction, so anything failing after the rebuild emptied the table, while the undo journal restored the catalog and its check passed, because that check cannot see rows.

## What was built

Inside `apply schema`, a rebuild may run only when it is the apply's only effect: the plan has exactly one step, no seed rows will be applied, and no registered module defines `endSchemaBatch`. Otherwise it is refused with `StatusCode.ERROR`, naming the table and module and the way forward: run `alter table … alter primary key (...)` on its own in autocommit, then re-apply.

Two checks raise the one error (`rebuildNotOnlyEffectError`):

- Before any step (`refuseCertainRebuild`): a module with no `alterTable` hook, where a rebuild is certain. It has to be early because `DROP TABLE` steps run before the key change. Renamed tables resolve to their live name through `diff.renames`.
- At the rebuild (`runAlterPrimaryKey`, reading a new `Database` flag): a hook that raises `UNSUPPORTED`, which only running it reveals. Earlier steps unwind as for any failed step. The flag is held around the whole loop, so an undo needing a rebuild is refused too.

Accepted consequences: a rebuild with good seed rows, which used to work, is now refused, and so is any rebuild an apply would run in a database with the isolation module registered. A direct `ALTER PRIMARY KEY` in autocommit is unaffected and is the workaround. A module missing `renameTable` or `createIndex` gets that capability refusal from both checks, so it is never told to run a statement that cannot succeed; in a multi-step plan that error now arrives before any step rather than wrapped as `Failed to execute DDL: …`.

Tests are in `apply-schema-restore.spec.ts`, under `a primary-key rebuild that is not the only effect of the apply`.

## How to try it

Register `makeNoAlterModule({ withRenameTable: true })` as the default module, create `t (a, c, b, primary key (a))` with rows, and declare the same table with `primary key (c)` plus anything else. `apply schema main` is refused and the rows stay. `alter table t alter primary key (c)` then succeeds, and `diff schema main` no longer lists a key change.

## Review findings

Read the diff of `ticket(implement): bug-apply-schema-loses-rows-after-rebuild-when-later-step-fails` before the handoff, then ran a throwaway spec (deleted) against the shapes below.

**Major: the one-step apply is still exposed to a failing commit.** The handoff scoped this to a direct `ALTER PRIMARY KEY`, and the docs and the function comment said nothing that can fail follows an allowed rebuild. Ran it: a one-step plan whose rows already break a deferred foreign key fails with `CHECK constraint failed: fk` and leaves the table empty. Same root cause and site as the open backlog ticket, so appended as an arm to `bug-rebuild-loses-rows-when-implicit-commit-fails` rather than filed fresh; that ticket's reasoning that refusing is unavailable was widened to both shapes. Corrected `docs/schema-undo-plan.md` and `docs/schema.md`, which now state the exposure, and added a `NOTE:` on `rebuildWouldBeOnlyEffect`. This is a remaining row-loss path on third-party backends only, and this ticket does not close it.

**Minor, fixed:** the refusal message said "alongside other work", which was false for a one-step plan refused only because a registered module defines `endSchemaBatch`. It now names the three actual causes.

**Tripwires:**

- A module defining `endSchemaBatch` without `beginSchemaBatch` blocks rebuilds it could never refuse: `NOTE:` added in `rebuildWouldBeOnlyEffect`. It errs toward refusing.
- A declining hook plus a table rename in one plan makes the workaround message name the post-rename table: the implementer's `NOTE:` above the refusal in `runAlterPrimaryKey` stands. Kept as a note because rows are safe and it takes a third-party module that declines.

**Checked, no defect:**

- Refusal in a non-`main` schema: the workaround text qualifies the table, following it keeps the rows, and the re-apply then succeeds.
- Explicit transaction with a one-step plan: refused by the existing transaction check, rows kept.
- A failing statement later in the same `exec` batch: statements commit separately, rows kept.
- Assertion over the table: refused at the rebuild's internal drop before anything is lost (already `bug-rebuild-drop-refused-by-user-facing-guards`).
- Flag lifetime: restored in a `finally`, not set when the before-any-step check throws, and seeding runs after it is restored and cannot rebuild.
- Only `runAlterPrimaryKey` reaches the rebuild, so there is no second entry point to guard.
- Built-in backends: memory and store handle `alterPrimaryKey` natively, and neither reaches either check. The isolation wrapper always defines both batch hooks, which is what the docs state.
- Differ: a pure rename of a key column does not set `primaryKeyChange`, so it cannot trigger a false refusal.
- Import direction: `schema-declarative.ts` importing `alter-table.ts` creates no cycle per the handoff; lint and the build type-check passed.

**Tests:** kept all eight; each pins a separate branch or decision, and the implementer confirmed each fails with its guard removed. Added none: the commit-failure arm belongs to the backlog ticket's fix, and the refused undo needs a module that re-keys forward and declines backward, for a behaviour that is only the `finally` scope of one flag.

**Docs:** read all four changed docs plus `usage.md`, `module-events.md`, `module-capabilities.md`, `design-isolation-challenges.md` and the isolation README. The last five describe the rebuild or the hooks without any claim this change invalidates, so they were left alone.

**Hygiene and structure:** no findings. The new helpers are small and single-purpose. `alter-table.ts` and `database.ts` were already large and this adds little to them, so no size ticket.

**Validation:** `yarn workspace @quereus/quereus run lint` exit 0. `yarn test` exit 0 after the review edits, every workspace passing, including the previously flaky `sync-coordinator` round-trip, whose harness a triage commit changed after the implement stage. `yarn test:store` was not run: this review changed only comments, an error message and docs, and both store-backed paths re-key natively.
