description: When "apply schema" removes a constraint and then fails, the rollback now puts the constraint back without re-checking it against the existing rows and tables, so the database returns to its pre-apply state instead of being left half-migrated.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts   # engine-side checks stand down; sets the marker on the module call
  - packages/quereus/src/vtab/module.ts   # `restoring?: true` on the addConstraint arm, with the contract
  - packages/quereus/src/vtab/memory/module.ts   # passes the marker to the manager
  - packages/quereus/src/vtab/memory/table.ts   # same, for the alterSchema route (not in the original ticket's list)
  - packages/quereus/src/vtab/memory/layer/manager.ts   # addConstraint, addUniqueConstraint, addForeignKeyConstraint
  - packages/quereus-store/src/common/store-module-alter.ts   # alterAddConstraint
  - packages/quereus-store/src/common/store-module-index.ts   # corrected comments on the skipped duplicate check
  - packages/quereus-isolation/src/isolation-module.ts   # describeRowValidatingAlter
  - packages/quereus-isolation/src/alter-migration.ts   # NOTE at installOverlayUniqueConstraint
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 11
  - packages/quereus/test/apply-schema-restore.spec.ts   # the collation case
  - docs/schema-undo-plan.md
  - docs/module-authoring-schema-changes.md
repro: verified
----

# A rollback's re-added constraint is no longer validated as if it were new

The undo of `DROP CONSTRAINT c` is `ALTER TABLE … ADD constraint c …`. That statement used to judge the constraint against the current catalog and rows, so an apply that failed could end in "The schema is partially migrated and could not be restored" for a constraint the table had all along.

## What changed

The rule: an `ADD CONSTRAINT` issued during an unwind makes no judgement about the constraint, and still does everything that installs it.

- **Engine.** During an unwind, `rejectCheckViolatedByExistingRows` returns at its top line, which covers both the engine-side and the module-routed arm. The foreign key collation and key-arity block is skipped. The catalog-shape checks (`assertConstraintNameFree`, `assertUniqueConstraintNotDuplicated`, `assertUniqueConstraintIndexNameFree`), `assertDdlTransactionPolicy` and the capability checks stay on.
- **Module channel.** The engine adds `restoring: true` to the `addConstraint` change only during an unwind. The field is absent otherwise, so no existing call site sees a difference.
- **Memory.** With the marker, skips `validateForeignKeyOverExistingRows`, `validateUniqueOverEffectiveRows` and `assertUniqueOverRestorableStates`. The covering index is still built.
- **Store.** With the marker, skips `validateUniqueOverExistingRows`, `judgeRollbackStates` and `validateForeignKeyOverExistingRows`. The `_uc_*` store is still built by `reconcileImplicitUniqueIndexStores`.
- **Isolation.** `describeRowValidatingAlter` returns undefined when restoring, so `effectiveRowsFor` raises no `BUSY` refusal for a scan that will not run.

## Tests added

- `50.4-declare-schema-apply-restore.sqllogic` § 11, on both backends: six tables each give up a constraint a fresh `ADD CONSTRAINT` would refuse, then `ub` fails. `diff schema` proves every constraint came back, because a restored catalog plans each `DROP CONSTRAINT` again. It also checks that the violating rows are still there, and that the CHECK reading `o` and the foreign key to `p` still refuse new bad rows.
- `apply-schema-restore.spec.ts`, "a UNIQUE the stored rows no longer satisfy is restored, and its covering index is rebuilt", memory backend: the collation is redefined so stored rows collide. It asserts the step's own error with no "could not be restored", a matching fingerprint, both rows kept, and a new duplicate refused.

## Validation

`yarn build`, `yarn lint`, `yarn test` and `yarn test:store` all pass (the store run: 10929 passing, 32 pending).

Both new tests failed before the fix. Because the sqllogic section uses one apply and an unwind stops at its first refusal, that failure only showed one guard firing. So each of the six cases was also run on its own in a throwaway spec on the memory backend, with the engine's fix switched off and then on. With it off, each case produced the refusal the original ticket's table lists. With it on, each one restored. That spec is not committed.

## Known gaps for the reviewer

- **The store's UNIQUE path has no committed test.** It needs a redefined collation, which the sqllogic runner cannot do, and `apply-schema-restore.spec.ts` runs on memory only. A throwaway spec against the isolated LevelDB store did pass: restored, both colliding rows kept, new duplicate refused. Consider whether this deserves a permanent test in the store package.
- **The isolation change is only lightly exercised.** Store mode runs behind the isolation layer, so the `restoring` field does reach the store through it. No test restores a UNIQUE with rows staged in an open transaction or under a savepoint, so the `describeRowValidatingAlter` branch that suppresses `BUSY` was never run with an effect to observe.
- **One refusal deliberately remains.** `installOverlayUniqueConstraint` still validates the issuing connection's staged rows, so duplicates staged in an overlay would still fail the undo. This follows the ticket and is recorded as a `NOTE:` at that site and in the docs.
- **The memory `alterSchema` route was also changed.** `vtab/memory/table.ts` now passes the marker too. Isolation only forwards CHECK that way today, and a CHECK has no module-side scan, so this keeps the rule uniform rather than fixing an observed failure.

## Related open tickets, not changed here

- `bug-apply-undo-refused-when-recreated-object-does-not-validate`: the maintained-table path still validates on undo. Gating inside `validateForeignKeyOverExistingRows` was rejected because it would have stood down only part of that path.
- `bug-add-check-or-foreign-key-ignores-rollback-states`: the gate at the top of `rejectCheckViolatedByExistingRows` covers its CHECK half if that refusal lands inside the function. Its foreign key half would need to honour `restoring` itself.

## Reviewer note

Store-mode logic tests load the store and isolation packages from `dist`. Running `yarn test:store` without rebuilding after a change to those packages gives a misleading failure, so run `yarn build` first.
