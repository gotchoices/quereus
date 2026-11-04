description: When "apply schema" removes a constraint and then fails, the rollback now puts the constraint back without re-checking it against the existing rows and tables, so the database returns to its pre-apply state instead of being left half-migrated.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts   # engine-side checks stand down; sets the marker on the module call
  - packages/quereus/src/vtab/module.ts   # `restoring?: true` on the addConstraint arm, with the contract
  - packages/quereus/src/vtab/memory/module.ts   # passes the marker to the manager
  - packages/quereus/src/vtab/memory/table.ts   # same, for the alterSchema route
  - packages/quereus/src/vtab/memory/layer/manager.ts   # addConstraint, addUniqueConstraint, addForeignKeyConstraint
  - packages/quereus-store/src/common/store-module-alter.ts   # alterAddConstraint
  - packages/quereus-store/src/common/store-module-index.ts   # corrected comments on the skipped duplicate check
  - packages/quereus-isolation/src/isolation-module.ts   # describeRowValidatingAlter
  - packages/quereus-isolation/src/alter-migration.ts   # NOTE at installOverlayUniqueConstraint
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 11
  - packages/quereus/test/apply-schema-restore.spec.ts   # the collation case, memory backend
  - packages/quereus-store/test/apply-undo-restores-unique.spec.ts   # the collation case, bare and isolated store
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
- **Memory.** With the marker, skips `validateForeignKeyOverExistingRows`, `validateUniqueOverEffectiveRows` and `assertUniqueOverRestorableStates`. The covering index is still built. `vtab/memory/table.ts` passes the marker on the `alterSchema` route too, which isolation uses only for CHECK today; that keeps the rule uniform rather than fixing an observed failure.
- **Store.** With the marker, skips `validateUniqueOverExistingRows`, `judgeRollbackStates` and `validateForeignKeyOverExistingRows`. The `_uc_*` store is still built by `reconcileImplicitUniqueIndexStores`.
- **Isolation.** `describeRowValidatingAlter` returns undefined when restoring, so `effectiveRowsFor` raises no `BUSY` refusal for a scan that will not run.

## Tests

- `50.4-declare-schema-apply-restore.sqllogic` § 11, on both backends: six tables each give up a constraint a fresh `ADD CONSTRAINT` would refuse, then `ub` fails. `diff schema` proves every constraint came back. It also checks that the violating rows are still there, and that the CHECK reading `o` and the foreign key to `p` still refuse new bad rows.
- `apply-schema-restore.spec.ts`, memory backend: the collation is redefined so stored rows collide. It asserts the step's own error, a matching fingerprint, both rows kept, and a new duplicate refused.
- `apply-undo-restores-unique.spec.ts`, added in review, bare and isolated store: the same collation case, and that the covering store holds both colliding rows.

## Validation

After the review's changes: `yarn build` and `yarn lint` clean, `yarn test` passing (engine: 10936 passing, 25 pending), and `yarn test:store` passing (10929 passing, 32 pending). The store spec fails on both stacks when the store's `restoring` gate is removed.

## Review findings

**Read:** the implement diff first, then the handoff, then the code around each change: the differ's undo builders, the isolation layer's `alterTable` and overlay routing, the seed step in `schema-declarative.ts`, and the docs below.

**Probed with a throwaway spec (not committed), on memory, bare store and isolated store:** committed rows that collide; the same with rows staged in an open transaction and a savepoint, then `rollback to` and `commit`; duplicates staged in the open transaction; and a constraint alongside a unique index on the same column. Every case restored except staged duplicates on the isolated store, described next.

**Major, parked as a tripwire: staged duplicates on the isolated store.** The handoff listed this refusal as deliberate, but its `NOTE:` described it as hypothetical, and it is reachable. Stage `'a'` and `'A'` in a transaction, re-register the collation so they collide, then fail an apply in that transaction. The undo fails as "could not be restored", with an INTERNAL drift error inside it. This also got slightly worse with this change. The underlying module used to judge those rows and refuse before changing anything. Now it installs the constraint first, so it holds `c` while the catalog does not. A later `add constraint c` in that session was accepted, which I expect leaves the module with `c` twice, though I did not inspect that. No ticket: it needs a mid-transaction collation change plus a failed apply in the same transaction, and the error reports the failure honestly. Rewrote the `NOTE:` at `installOverlayUniqueConstraint` with the facts, corrected the comment in `IsolationModule.alterTable` that called this rejection unreachable, and updated `docs/schema-undo-plan.md`.

**Minor, fixed:**
- Store UNIQUE restore had no committed test, and the isolated path had none either: added `apply-undo-restores-unique.spec.ts`. This is the handoff's first known gap.
- `bug-add-check-or-foreign-key-ignores-rollback-states` did not say its new refusal must respect an unwind: appended a section to that backlog ticket.

**Checked, no defect:**
- ADD COLUMN's inline `addConstraint` calls carry no `restoring`, and need none. The undo of `DROP COLUMN` is irreversible rather than an `ADD COLUMN`, so an unwind never issues one.
- Seed rows cannot be in an overlay during an unwind, because the seed step runs after the migration loop and its failure does not unwind.
- `restoring` survives every pass-through: isolation forwards `change` intact, and the sync adapter works from the statement's syntax tree rather than this type.
- The flag cannot leak to other statements: the existing `_setSchemaUnwinding` contract holds, set only around the journal's statements with the mutex held.
- Type safety and error handling: the marker is `true | undefined`, and a module that ignores it fails with the existing refusal.
- Performance and resource cleanup: this change only removes scans during an unwind and holds no new resources.
- Docs: `schema-undo-plan.md`, `module-authoring-schema-changes.md` and the `_setSchemaUnwinding` docstring match the code. `schema-declarative.md` § Failure and restoration makes no claim about constraint validation, so it needs no change.

**Tests reviewed:** the implementer's sqllogic section and memory spec each cover a behaviour no other test does, so none were cut. A test exercising `describeRowValidatingAlter`'s `restoring` branch was not added. That `BUSY` only fires for an overlay module without `savepointRowSources`, the bundled overlay has it, and the branch is one line. The savepoint probe above showed the bundled stack restores correctly.

**Not caused by this ticket, not filed:** on the bare store a plain `alter table … drop constraint` inside a transaction commits the pending rows and savepoints, with no apply involved, logging "transaction was committed out from under it". `bare-ddl-rollback-states.spec.ts` describes only some DDL as staying inside the transaction, so this looks like known behaviour, though I did not find it stated as a decision.

**Accepted-tradeoff NOTEs:** none at these sites. **Tripwires:** the one above, at `installOverlayUniqueConstraint`.

## Related open tickets, not changed by this work

- `bug-apply-undo-refused-when-recreated-object-does-not-validate`: the maintained-table path still validates on undo.
- `bug-add-check-or-foreign-key-ignores-rollback-states`: see the section added to it.
