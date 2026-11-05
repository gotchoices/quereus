description: A schema migration that changes views can lose every view when a later step fails, because views are dropped and restored in the wrong order for views built on other views. A migration that redefines a view a table rule reads can never apply at all, because the normal safety check on dropping a view refuses it.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan: viewsToDrop and view creates run in declaration order
  - packages/quereus/src/runtime/emit/schema-declarative.ts # runStepsWithUndoJournal, unwindJournal: strict reverse, stops at the first failed undo
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts # assertNoExpressionDependsOn: stands down during an unwind, not during a forward step
  - docs/schema-declarative.md # Migration Order
  - docs/schema-undo-plan.md
repro: verified
----

Reported in GitHub issue #39 on 4.24.0, with a self-contained script. Re-run on the v4.26.0 code, using a memory module with no `alterTable` so that `add column` fails. Two of the issue's three failures remain:

```
table T (Id integer primary key, N integer);
view V1 as select sum(N) as S from T;
view V2 as select S * 2 as D from V1;
```

**A: a failed migration loses every view.** Redefining V1 and V2 while adding a column to T plans:

```
DROP VIEW IF EXISTS App.V1
DROP VIEW IF EXISTS App.V2
ALTER TABLE App.T ADD COLUMN At text null     -- fails
create view App.V1 ...
create view App.V2 ...
```

The reversed undo recreates V2 before V1, which is refused with `Table 'V1' not found`, and the unwind stops there. The result is "The schema is partially migrated and could not be restored", with no views left. The reporter has seen a database in this state on a phone.

**B: a view a CHECK reads can never be redefined.** Add `table P (Id integer primary key, U integer, check (U <= (select S from V1)));` to both versions. The forward `DROP VIEW IF EXISTS App.V1` is refused by the CHECK guard ("cannot drop view 'app.V1': it is referenced by the CHECK constraint"). The database is restored intact, but the new schema can never be reached. This does not depend on the module. The reporter hits it on a real schema, where `TradingVariable`'s CHECK reads the view `TallyClosed`.

The issue's third failure, an undo that could not drop a view a CHECK names, no longer reproduces: the guards stand down during an unwind (`docs/schema-undo-plan.md` § Guards during an unwind).

Expected:

- `viewsToDrop` runs dependents first and view creates run dependencies first, so the reversed journal is a valid undo order. A dependency through a chain of views counts, and so does one the differ cannot see without parsing the view body.
- A migration that drops and recreates a view a CHECK or assertion reads applies. The guard must still refuse a migration that removes such a view and does not recreate it, since that leaves a rule reading nothing. Decide the rule from the plan: standing the guard down for every forward step, as the issue suggests, would lose that refusal.
- The new view must still satisfy what reads it. Existing rows are not re-validated against a CHECK whose view changed; check what a user-issued redefinition does and match it, or say why not.

`bug-apply-undo-refused-when-recreated-object-does-not-validate` is related but separate: an undo that recreates an object which fails validation for its own reasons. The issue's optional retry of failed undo statements until nothing changes is not needed if the order is right.

Keep the two scenarios above as the reproduction.
