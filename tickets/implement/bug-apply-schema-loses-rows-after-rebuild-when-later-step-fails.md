description: On a storage backend that cannot change a primary key in place, an "apply schema" that rebuilds a table and then fails on anything later leaves the table empty, while reporting an ordinary failure with the schema restored. The apply should refuse the rebuild unless it is the only thing the apply does.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAlterPrimaryKey: the explicit-transaction refusal (~1951) is where the new check goes; rebuildViaShadowTable's precondition list (~2166)
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema (plan built ~345, loop called ~351); runBatchedMigrationLoop
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # home for the shared refusal error, next to isExplicitTransactionOpen
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding (~2845) is the pattern for the new flag
  - packages/quereus/test/no-alter-module.ts   # stub backend; needs an option for a hook that declines the re-key
  - packages/quereus/test/apply-schema-restore.spec.ts   # where the coverage goes
  - docs/schema.md   # § Failure and restoration
  - docs/schema-undo-plan.md   # § Restoring a failed apply
  - docs/module-authoring-schema-changes.md   # the list of rebuild refusals (~96-100)
repro: verified
difficulty: medium

# Committed rows are lost when a rebuilt primary key's apply fails

A backend that cannot re-key in place changes a primary key through the engine's rebuild: create a hidden copy of the table, copy the rows, drop the original, rename the copy over it. The drop and rename survive a rollback; the row copy does not. `ALTER PRIMARY KEY` is already refused inside an explicit transaction for this reason.

`apply schema` in autocommit runs all its work in one implicit transaction, so anything that fails after the rebuild rolls back the copied rows. The undo journal restores the catalog and its check passes, because the check renders the catalog and cannot see rows. The caller gets the failure with no hint of the loss.

## Reproduced

Temporary spec against `makeNoAlterModule({ withRenameTable: true })` as the default module, from `t (a, c, b, primary key (a))` with rows `(1, 10, 1), (2, 20, 1)`. The spec is deleted; each row below becomes a test or is already covered. In the declining-hook row the later step failed because the throwaway stub forwarded to a separate inner module, not because of a constraint; what it shows is that the hook route reaches the rebuild and loses the rows the same way.

| Shape | Outcome | Rows afterwards |
|---|---|---|
| Rebuild, then a failing `ADD CONSTRAINT` on the same table (the original report) | fails | **none** |
| Rebuild, then a failing step on an unrelated table | fails | **none** |
| Two rebuilds, the second collides under its new key | fails | first table **empty**, second intact |
| Same shape through a hook that raises `UNSUPPORTED` instead of having no hook | fails | **none** |
| One-step plan, a module's `endSchemaBatch` refuses the commit | fails with the module's error | **none** |
| One-step plan, `with seed`, a malformed seed row | fails, key already changed | **none** |
| One-step plan, nothing fails, with or without a good seed | succeeds | kept |
| Direct `alter table … alter primary key` in autocommit | succeeds | kept |
| Explicit transaction | refused by the existing check, unwound | kept |
| Memory backend, original report's shape | fails | kept |

The last two one-step failures matter for the design: "a rebuild plus another step" is too narrow a rule. A refused commit and a failing seed lose the rows with a single step in the plan.

## The rule

**In `apply schema`, a rebuild is allowed only when it is the apply's only effect.** That means all of:

- the plan has exactly one step;
- no seed rows will be applied (`with seed` and at least one table has rows);
- no registered module defines `endSchemaBatch`, because any of them could refuse the commit afterwards.

Otherwise the apply refuses the rebuild with `StatusCode.ERROR`. The message names the table and module and gives the way forward: run `alter table … alter primary key (…)` on its own in autocommit, then re-apply. The direct `ALTER` half was confirmed above. The re-apply was not run; it should have no key change left to plan, and the first test below pins that.

Accepted consequence: the good-seed shape, which works today, becomes a refusal, and so does a rebuild in any database with the isolation module registered, since that module always defines `endSchemaBatch`. Both have the same workaround.

## Mechanism: two checks, one error

**Before any step runs, for the case that can be known.** After `generateMigrationPlan` in `emitApplySchema`, when the rebuild is not the apply's only effect, look through `diff.tablesToAlter` for a `primaryKeyChange` on a table whose module has no `alterTable` hook, and throw. `alter.tableName` is the post-rename name, so map it back through `diff.renames` (`kind === 'table'`) to find the live table. Refusing here matters because of plan order: `DROP TABLE` steps run before the key change, so a later refusal would already have destroyed that table's rows and could only report the schema as partially migrated.

**At the rebuild, for the case that cannot be known.** A module's hook may raise `UNSUPPORTED` as the documented protocol, and the isolation wrapper always defines the hook, so only running it reveals a rebuild. Add a `Database` flag modelled on `_setSchemaUnwinding` (set and restored in a `finally`, returning the prior value), held around `runBatchedMigrationLoop` when the rebuild is not the apply's only effect. Check it in `runAlterPrimaryKey` beside the explicit-transaction refusal, after the capability checks, so "this module can never do this" still wins as the more informative answer. The refused step fails like any other: earlier steps unwind through the journal, and an earlier irreversible step reports the documented partially-migrated residual.

The flag also covers the unwind, so an undo that would need a rebuild is refused and reported as *undo statement failed* rather than losing rows. After this change a rebuild can never run during an unwind for any other reason: the one-step case that may rebuild has an empty journal and no module able to refuse.

Keep one error-building function in `ddl-transaction-policy.ts` for both checks. Extend the existing `NOTE:` above the explicit-transaction refusal, since a future `'transactional'` tier would make this refusal over-broad too.

## Rejected alternative

Committing the implicit transaction right after the rebuild would keep the apply fully undoable instead of refusing it. It was rejected because a nested statement would be committing a transaction its outer statement owns, and because the commit would run deferred checks and assertions against a half-migrated schema mid-plan. The ticket's expected behaviour accepts a refusal, and the workaround is one statement.

## Not in scope

A direct `ALTER PRIMARY KEY` whose implicit commit fails loses rows the same way, and refusing cannot fix it: see backlog `bug-rebuild-loses-rows-when-implicit-commit-fails`.

## TODO

- Add the shared refusal error to `ddl-transaction-policy.ts`, and the `Database` flag with its getter
- Work out "the rebuild is the apply's only effect" in `emitApplySchema` (plan length, seed rows, any module in `schemaManager.allModules()` defining `endSchemaBatch`), and hold the flag around `runBatchedMigrationLoop`
- Add the before-any-step check for hookless modules in `emitApplySchema`, resolving renamed tables through `diff.renames`
- Add the at-the-rebuild check in `runAlterPrimaryKey`, and a fourth precondition bullet on `rebuildViaShadowTable`'s comment
- Add a `declineAlterPrimaryKey` option to `makeNoAlterModule`: an `alterTable` that raises `UNSUPPORTED` for `alterPrimaryKey` and forwards other arms to the same inner module. Update the file's header comment
- Add tests to `apply-schema-restore.spec.ts`, asserting rows and key are intact after each refusal:
  - the original report's shape on a hookless module, where the error names the workaround and following it succeeds
  - a plan that also drops another table: that table survives, which is what shows the refusal came before any step
  - a declining hook after an earlier step, where the earlier step is unwound
  - a failing-commit module on a one-step plan (`endSchemaBatch` defined), refused
  - a one-step plan `with seed`, refused
  - a one-step plan with neither, which still rebuilds and keeps its rows
- Update `docs/schema.md` § Failure and restoration, `docs/schema-undo-plan.md` § Restoring a failed apply, and the refusal list in `docs/module-authoring-schema-changes.md`
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`
