description: A schema migration that removes a rule (a foreign key or CHECK) together with something that rule was blocking is refused, because the migration removes the rule only after the blocked step. Removing the rules first lets these declarations apply in one go.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan (~3448), pushTableAlters (~3710), pushConstraintRenamesAndDrops (~3840), UndoRenderer.constraintNamesHeld (~4206)
  - packages/quereus/src/schema/manager.ts # assertNoReferencingChildrenForDrop (~1555), the foreign-key refusal on DROP TABLE; unchanged
  - packages/quereus/src/runtime/emit/alter-table.ts # assertRenamedColumnNotReadAsContextVariable, the RENAME COLUMN refusal; unchanged
  - docs/schema-declarative.md # Migration Order; Redefining what a rule reads
  - docs/schema-undo-plan.md # the ADD COLUMN row of the undo table describes the taken-names set
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # or a nearby declarative file, for the repro cases
repro: verified
----

## The problem

`generateMigrationPlan` emits every `ALTER TABLE … DROP CONSTRAINT` in stage 2 of `pushTableAlters`, after the table drops and after stage 1 (`RENAME COLUMN`). Two engine guards judge the half-migrated catalog at an earlier step and refuse, although the declared end state is valid.

Foreign key (memory module, `pragma foreign_keys = true`):

```sql
create table T (Id integer primary key); insert into T values (1);
create table P (Id integer primary key, R integer, constraint pf foreign key (R) references T(Id));
insert into P values (1, 1);
declare schema main { table P { Id integer primary key, R integer } }
apply schema main;
```

Plan: `DROP TABLE IF EXISTS t ; ALTER TABLE P DROP CONSTRAINT pf`. Fails at the first step with `FOREIGN KEY constraint failed: cannot drop table 't' because table 'P' still has rows referencing it` (`SchemaManager.assertNoReferencingChildrenForDrop`). Verified the same refusal for:

- an unnamed inline foreign key (`R integer references T(Id)`), dropped by its stored auto-name `_fk_P_R`;
- the foreign-key column removed too (plan adds `DROP COLUMN R` in stage 4);
- the foreign key re-pointed from `T` to another table `U` (drop `pf` + add `pf … references U(Id)`).

Removing both tables already works (the child's `DROP TABLE` comes first).

CHECK blocking a column rename:

```sql
create table T3 (a integer primary key, x integer null, constraint k check (x > 0)) with context (who integer null);
declare schema main { table T3 { a integer primary key, who integer null with tags ("quereus.previous_name" = 'x'), constraint k check (new.who > 0) } with context (who integer null) }
apply schema main;
```

Plan: `ALTER TABLE T3 RENAME COLUMN x TO who ; ALTER TABLE T3 DROP CONSTRAINT k ; ALTER TABLE T3 ADD constraint k check (new.who > 0)`. Fails at the rename (`assertRenamedColumnNotReadAsContextVariable`): `CHECK constraint 'k' reads 'x' unqualified …`.

Both have one cause: the `DROP CONSTRAINT` step runs too late.

## The fix

Move every table's `DROP CONSTRAINT` steps into one phase of their own, early in `generateMigrationPlan`: after the table renames, the assertion drops and the `DROP MAINTAINED` detaches, and before `DROP TABLE`. Pull the drop loop out of `pushConstraintRenamesAndDrops`; `RENAME CONSTRAINT` stays in stage 2.

Why this is safe:

- `DROP CONSTRAINT` resolves by name only. It does not depend on column renames, added columns, column alters or the key change, so nothing that currently precedes it needs to.
- It keeps every ordering stage 2 relied on: a drop still comes before any `ADD CONSTRAINT` re-add, and a dropped UNIQUE still goes before `ALTER PRIMARY KEY`. A drop of a name that a `RENAME CONSTRAINT` then takes over now works too.
- The steps it now precedes (`ADD COLUMN` backfill, `SET DATA TYPE` conversion) are no longer judged by a rule the declaration removes. New and changed rules are still judged against all rows when stage 3 adds them.
- It runs after the detaches, as today, so a table leaving maintained status is plain when its constraints are dropped.
- A kept foreign key (one the declaration still has) is not in `constraintsToDrop`, so `DROP TABLE` of its parent is still refused while the child has referencing rows, before any parent rows are lost. This is the behaviour the original ticket requires to stay.
- The undo of a dropped constraint (`UndoRenderer.readdConstraint`) needs no change: the renderer is told about each rename when its step is pushed, so at the new position only table renames are in force and it replays only those over the re-added body, which is correct (Rule 1/Rule 2 in the `UndoRenderer` doc comment).
- `diff schema` output becomes runnable by hand for these shapes, and for a view removed with its CHECK (the CHECK is gone before `DROP VIEW`). The `releasedDrops` mechanism stays: DEFAULTs are still changed by `SET DEFAULT` in stage 2, after `DROP VIEW`.

One thing in the undo renderer does depend on the old order. `UndoRenderer.constraintNamesHeld` seeds a table's taken constraint names from the pre-apply catalog when the first `ADD COLUMN` undo is rendered, and its doc comment says this is accurate "because every phase that renames, drops or adds a constraint comes after `ADD COLUMN`". After the move, a name dropped earlier in the plan is free when `ADD COLUMN` runs, so the forward mint can take it (for example, a user-named `_check_e` removed while a new column `e` with an unnamed inline CHECK is added: the forward step mints `_check_e`, the undo would predict `_check_e_2`). Have the drop step tell the renderer (for example a `constraintDropLanded(table, name)` that seeds the set if needed and deletes the name), and update that doc comment and the `ADD COLUMN` row of `docs/schema-undo-plan.md`.

## Out of scope

A declaration that removes a table and adds a new foreign key naming it drops the parent first, then fails at `ADD CONSTRAINT` with the parent's rows already gone (verified: plan `DROP TABLE IF EXISTS t ; ALTER TABLE P ADD constraint pf foreign key (R) references T(Id)`). That happens today and this change neither causes nor fixes it; it is filed as `bug-apply-schema-drops-parent-before-new-foreign-key-to-it-fails` in backlog.

## TODO

- Add the early constraint-drop phase in `generateMigrationPlan` (after the detach loop, before the `DROP TABLE` loop), iterating `diff.tablesToAlter` and pushing each `constraintsToDrop` entry with `u.readdConstraint(...)` as today; remove the drop loop from `pushConstraintRenamesAndDrops` (rename it to match what it still does).
- Teach `UndoRenderer` about a landed constraint drop so `constraintNamesHeld` stays accurate; update its doc comment.
- Update the stage list in the `pushTableAlters` doc comment and the comment above the drops in `generateMigrationPlan`.
- Update `docs/schema-declarative.md` § Migration Order (new step between drops and renames/drops list; remove `DROP CONSTRAINT` from stage 2; stage 4's wording "after every table's `DROP CONSTRAINT`" still holds), and § Redefining what a rule reads (a removed CHECK is now dropped before `DROP VIEW`, so the "later `DROP CONSTRAINT`" wording, the known limit about `diff schema` run by hand, and the "between a released drop and the later `DROP CONSTRAINT`" limit apply only to DEFAULTs now). Update `docs/schema-undo-plan.md` for the taken-names set.
- Add sqllogic repro cases: the foreign-key declaration above applies (P keeps its row, `T` is gone); the rename declaration above applies; and a declaration that removes `T` while keeping `pf` is still refused with the foreign-key error and `T`'s row still present (no existing apply-schema test pins this).
- Update the expected plan text in tests that pin `diff schema` / plan order with `DROP CONSTRAINT` (about 20 files mention it: `grep -rln "DROP CONSTRAINT" packages/quereus/test`; the plan-order ones are mainly `schema-differ.spec.ts`, `schema/differ-undo-plan.spec.ts`, `declarative-equivalence.spec.ts`, `apply-schema-restore.spec.ts`, `50-declarative-schema.sqllogic`, `50.2-declare-schema-renames.sqllogic`, `50.4-declare-schema-apply-restore.sqllogic`). An expected order change is fine; a newly failing apply is not, and needs a look.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. `yarn test:store` is worth one run because the store module has its own `DROP CONSTRAINT` path.
