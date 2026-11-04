description: When "apply schema" removes a constraint and then fails, the rollback puts the constraint back by adding it as if it were new, so it is refused if the existing rows or tables would not pass a fresh check, and the database is left half-migrated. The rollback should restore the constraint without re-judging it.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts   # engine-side checks that must stand down; marks the module call
  - packages/quereus/src/vtab/module.ts   # SchemaChangeInfo addConstraint arm gains the `restoring` marker
  - packages/quereus/src/vtab/memory/module.ts   # passes the marker to the manager
  - packages/quereus/src/vtab/memory/layer/manager.ts   # addConstraint, addUniqueConstraint, addForeignKeyConstraint
  - packages/quereus-store/src/common/store-module-alter.ts   # alterAddConstraint
  - packages/quereus-store/src/common/store-module-index.ts   # reconcileImplicitUniqueIndexStores comment on the skipped duplicate check
  - packages/quereus-isolation/src/isolation-module.ts   # describeRowValidatingAlter
  - packages/quereus-isolation/src/alter-migration.ts   # installOverlayUniqueConstraint, for the NOTE
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic
  - packages/quereus/test/apply-schema-restore.spec.ts   # the collation case, which needs JavaScript
  - docs/schema-undo-plan.md
  - docs/module-authoring-schema-changes.md
repro: verified
----

# A rollback's re-added constraint is validated as if it were new

The undo of `DROP CONSTRAINT c` is `ALTER TABLE … ADD constraint c …`, run through the ordinary statement path. That path judges the constraint against the current catalog and rows. Those checks protect a user adding a new rule. In an unwind the constraint is one the table already had, and the goal is the pre-apply state whether or not that state would pass a fresh check, so a refusal leaves the schema partially migrated for no benefit.

## Reproduction

Run on the memory backend through a temporary spec, from `t (id, b)` with rows `(1, 1), (2, 1)`. Each declaration removes constraint `c` from table `e`, then adds `constraint ub unique (b)` to `t`, which fails forward. Each apply ended in "The schema is partially migrated and could not be restored: undo statement … failed (…)":

| starting state of `e` | where the undo was refused | refusal |
|---|---|---|
| `c check (x > (select max(id) from o))`, row valid when written, `o` grew later | `rejectCheckViolatedByExistingRows` | `CHECK constraint failed: c — existing rows in 'e' violate the constraint` |
| `c check (x > (select max(id) from zz))`, `zz` does not exist | same scan, while preparing it | `Table 'zz' not found in schema path: main` |
| `c foreign key (x) references p(id)`, orphan row inserted under `pragma foreign_keys = off` | `validateForeignKeyOverExistingRows`, from the module | `FOREIGN KEY constraint failed: e (x) has rows referencing a missing 'p'` |
| `c foreign key (x) references zz(id)`, parent absent, row inserted with the pragma off | same | `… referencing a missing 'zz'` |
| `c foreign key (x) references p`, `p` created afterwards with a two-column primary key | `resolveReferencedColumnsForEnforcement`, before the module call | `1 column(s) reference the primary key of 'main.p', which has 2 column(s)` |
| `c foreign key (x) references p(k)`, `p` created afterwards with a conflicting collation | `validateForeignKeyCollations`, before the module call | `declare conflicting collations` |
| `c unique (x)` on a custom collation, rows `'a'` and `'A'`, collation re-registered case-insensitive afterwards | the memory module's UNIQUE scan | `UNIQUE constraint failed: e (x)` |

A plain `c unique (x)`, and one alongside a `create unique index` on the same column, restored correctly: the plan does not change those rows, so the scan only fails when its comparison has changed. The redefined collation is the one way found to reach that through the public API. Rows written directly to a store by sync may be another; that was inferred from reading the code, not run.

The store backend was not run for any of these. It reaches the same `validateForeignKeyOverExistingRows` and the same engine-side checks, and has its own UNIQUE scan.

## Fix

**One rule: an `ADD CONSTRAINT` issued during an unwind makes no judgement about the constraint, and still does everything that installs it.** Both layers change, because the engine judges CHECK and the module judges UNIQUE and FOREIGN KEY.

**Engine (`add-constraint.ts`).** Read `rctx.db._isSchemaUnwinding()`, as the drop guards already do, and skip:

- `rejectCheckViolatedByExistingRows`. Gate at the top of that function, so one line covers both the engine-side and the module-routed arm.
- `validateForeignKeyCollations` and the `resolveReferencedColumnsForEnforcement` arity check.

Leave these on: `assertConstraintNameFree`, `assertUniqueConstraintNotDuplicated`, `assertUniqueConstraintIndexNameFree`, `assertDdlTransactionPolicy` and the capability checks. They are about the shape of the catalog rather than the rows. The undo runs in exact reverse, so the catalog at that point held this constraint without a conflict. If one of them does fire, it is a real defect that should surface as a failed undo.

**Module channel: a new optional field, `restoring?: true`, on the `addConstraint` arm of `SchemaChangeInfo`.** The engine sets it only during an unwind, so no existing call site changes.

Two alternatives were rejected:

- Calling `db._isSchemaUnwinding()` from the modules. That method is `@internal` and `packages/quereus/tsconfig.json` sets `stripInternal`, so it is absent from the published types and a third-party module could not call it without a cast. The field is also where a module author will read about the contract. A module that ignores the field fails safely: its scan refuses, and the apply reports "could not be restored" as it does today.
- Gating inside `validateForeignKeyOverExistingRows`, which would cover both modules from one line. The maintained-table path calls that helper too, so its undo would stand down for foreign keys only, leaving its CHECK and UNIQUE validation on. That path is tracked in `bug-apply-undo-refused-when-recreated-object-does-not-validate`.

**Memory (`manager.ts`, via `module.ts`).** Pass the marker into `addConstraint`. With it set, skip `validateForeignKeyOverExistingRows`, `validateUniqueOverEffectiveRows` and `assertUniqueOverRestorableStates`. Everything else in those arms stays, including `ensureSchemaChangeSafety` and the covering-index build. `addIndexToBase` does not reject duplicates here because the covering index is not flagged `unique`, as the existing comment explains.

**Store (`store-module-alter.ts`).** With the marker set, skip `validateUniqueOverExistingRows`, `judgeRollbackStates` and `validateForeignKeyOverExistingRows`. `reconcileImplicitUniqueIndexStores` still builds the `_uc_*` store and already passes `skipDuplicateCheck = true`, so duplicates do not refuse the build. Its comments say duplicates were already rejected, which needs correcting.

**Isolation (`isolation-module.ts`).** `change` already reaches the underlying module intact through `underlying.alterTable(db, schemaName, tableName, change, rowSource)`. `describeRowValidatingAlter` should return undefined when `restoring` is set, so `effectiveRowsFor` raises no `BUSY` refusal for a scan that will not run.

`installOverlayUniqueConstraint` still validates the issuing connection's staged rows through `createIndex`, so duplicates staged in an overlay would still refuse. Leave it, and add a `NOTE:` at that site: if an overlay can ever hold rows that break a UNIQUE it was written under, this refusal also has to stand down during an unwind.

**What stays true.** The fingerprint comparison in `unwindJournal` is unchanged and remains the backstop. A restored CHECK or foreign key over rows that break it is what the table had before the apply, including how the optimizer treats it, so nothing new is introduced. `permitsGrandfatheredCheckViolators` keeps its meaning outside an unwind.

The open ticket `bug-add-check-or-foreign-key-ignores-rollback-states` plans to add a rollback-state refusal to the CHECK and foreign key arms. The gate at the top of `rejectCheckViolatedByExistingRows` covers its CHECK half if that refusal lands inside the function.

## Tests

Add one section to `50.4-declare-schema-apply-restore.sqllogic`, which runs on both backends through `yarn test:store`. Cover the first six rows of the table.

`-- error: ub` alone does not prove a restore, because the wrapped "could not be restored" message also starts with the original error. Assert the restore with `diff schema main` after the failed apply: a restored catalog plans the `DROP CONSTRAINT` again, and an unrestored one does not. Also assert that the violating rows are still present, and that the re-added constraint is still enforced where it can be evaluated (the CHECK reading `o`, the foreign key to `p`).

Add one spec to `apply-schema-restore.spec.ts` for the UNIQUE row, since re-registering a collation needs JavaScript. Assert that the error is the step's own, without "could not be restored", and that a later insert of a new duplicate is refused, which shows the covering index was built.

## Docs

- `docs/schema-undo-plan.md`, § Guards during an unwind: it currently says validation of a re-added constraint stays on. Replace that sentence with the rule above, and list what stands down and what stays on.
- `docs/module-authoring-schema-changes.md`: add `restoring` to the `addConstraint` row of the per-arm table. Skip row judgement, still build every structure, and note that ignoring it makes the unwind report "could not be restored".
- `Database._setSchemaUnwinding` docstring, which currently describes only the reference guards on drops.

## TODO

- Add the sqllogic section and the UNIQUE spec, and confirm they fail before the fix
- Add `restoring?: true` to the `addConstraint` arm in `vtab/module.ts`, with a comment stating the contract
- Gate the engine-side checks in `add-constraint.ts` and set the marker on the `module.alterTable` call
- Honour the marker in the memory manager, through `vtab/memory/module.ts`
- Honour the marker in the store's `alterAddConstraint` and correct the `reconcileImplicitUniqueIndexStores` comments
- Return undefined from `describeRowValidatingAlter` when restoring, and add the `NOTE:` at `installOverlayUniqueConstraint`
- Update the three docs above
- Run `yarn build`, `yarn lint`, `yarn test` and `yarn test:store`, because the store and isolation paths change
