description: When a schema migration replaces views built on other views, it drops and creates them in an order that does not follow those dependencies. If a later step fails, the rollback cannot restore the views and the database is left with none of them; some migrations also fail outright on creating a view before the view it reads.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/schema/schema-differ.ts # computeSchemaDiff (view loops ~783-820), followDeclaredViewsInAddedColumnReads (~2589), viewStageTwoItems (~3459), MigrationCreate (~47)
  - packages/quereus/src/schema/dependency-order.ts # orderDependentsFirst, already stable on unrelated items
  - packages/quereus/src/runtime/emit/schema-declarative.ts # runJournalInReverse: strict reverse, stops at the first failed undo; no change expected
  - packages/quereus/test/apply-schema-restore.spec.ts # home of the restore reproduction; already imports makeNoAlterModule
  - packages/quereus/test/apply-schema-alter-order.spec.ts
  - docs/schema-declarative.md # Migration Order
  - docs/schema-undo-plan.md
repro: verified
----

Reported in GitHub issue #39 on 4.24.0, and re-run on the current code with a temporary spec. The sibling ticket `bug-apply-schema-redefine-view-a-rule-reads` carries the issue's other failure.

## Reproductions

All use a module with no `alterTable` hook (`makeNoAlterModule`, registered as the default module), so `add column` fails, except the third, which needs no failing step. The starting tables are `table T (Id integer primary key, N integer)`, and the new declaration adds `At text null` to `T`.

**1. Chain, failing later step (the issue's scenario).** From `view V1 as select sum(N) as S from T; view V2 as select S * 2 as D from V1;`, redefine both:

```
DROP VIEW IF EXISTS V1
DROP VIEW IF EXISTS V2
ALTER TABLE T ADD COLUMN At text null     -- fails
create view V1 as select sum(N) + 1 as S from T
create view V2 as select S * 3 as D from V1
```

Result: `The schema is partially migrated and could not be restored: undo statement 'create view V2 as select S * 2 as D from V1' failed (Table 'V1' not found in schema path: main)`, with no views left.

**2. Chain through a view the plan does not touch.** From `V1`, `view M as select S from V1`, `view V3 as select S as D from M`, redefine `V1` and `V3` and leave `M` alone. The plan drops `V1` then `V3`, and the undo of `V3` fails the same way, naming `V1`, which `V3` does not mention. Only `M` is left.

**3. Forward failure through an untouched view.** Same three views, no failing step, with the new declaration written `V3`, `M`, `V1`. The plan creates `V3` before `V1`, and the create fails with `Table 'V1' not found`. This one is restored correctly, but the migration can never apply as written.

## Cause

`diff.viewsToDrop` is filled in declared order, then orphaned views in catalog order. `runJournalInReverse` undoes in exact reverse, and each undo is a `create view` that plans its body, following view bodies as it goes. So the undo order is valid only when dependents were dropped first.

Confirmed without a code change: declaring `V2` before `V1` in scenario 1 makes the plan drop `V2` first, and the apply then reports only the step's own error, with both original views back. The issue's suggestion of retrying failed undo statements until nothing changes is not needed.

`viewStageTwoItems` orders a create only after the new views its body names directly (`runsAfter`), so a chain through an existing view gives no edge. That is scenario 3.

## Fix

**Drops.** After both view loops in `computeSchemaDiff`, sort `diff.viewsToDrop` with `orderDependentsFirst`. A view's dependencies are every view it reaches through the pre-apply catalog's view bodies (`CatalogView.select`, walked with `objectsNamedIn`), through views that are not being dropped as well. The sort belongs in `computeSchemaDiff` because that is where the catalog is available and `diff schema` must show the same order. `orderDependentsFirst` ignores keys that are not items, keeps unrelated views in their current order, and keeps a cycle in input order, so a malformed catalog cannot hang. A view with no `select` (a hand-built catalog) contributes no edges. The set must be walked before `droppedInThisDiff` is read only if that read becomes order-sensitive; it is not today.

**Creates.** Carry each create's reach through the declared views on the diff, as `TableAlterDiff.addedColumnReads` does, because `generateMigrationPlan` runs without a catalog for `diff schema`. An optional field on `MigrationCreate` (for example `viewReach?: readonly string[]`, lowercased names) fits; `viewStageTwoItems` then uses `[...named, ...(create.viewReach ?? [])].filter(name => newViews.has(name))` for `runsAfter`. A declared chain is the right graph here because the creates produce the declared end state. Extract the walk in `followDeclaredViewsInAddedColumnReads` into one helper so both callers share it; the redefine ticket reuses it too.

A view reading a maintained table is not followed through the maintained table's body, because `create view` treats that as a table. This was read from the code, not run.

## Out of scope

`bug-apply-undo-refused-when-recreated-object-does-not-validate` is a separate failure: an undo that recreates an object that fails validation for its own reasons.

## TODO

- Add the three scenarios above as tests in `test/apply-schema-restore.spec.ts`: scenarios 1 and 2 must end with the step's own error unwrapped and the catalog fingerprint unchanged, and scenario 3 must apply and then re-diff empty.
- Sort `viewsToDrop` in `computeSchemaDiff` by reach through the catalog's view bodies.
- Extract the declared-view walk from `followDeclaredViewsInAddedColumnReads`, record each view create's reach on the diff, and use it for `runsAfter` in `viewStageTwoItems`.
- Check that views with no relation between them keep their present order, so `diff schema` output changes only where a dependency requires it.
- Update `docs/schema-declarative.md` § Migration Order (steps 2 and 4.2) and `docs/schema-undo-plan.md` § Restoring a failed apply to state that view drops run dependents first, and why the reversed journal is then a valid order.
- Run `yarn build`, `yarn test` and `yarn lint`.
