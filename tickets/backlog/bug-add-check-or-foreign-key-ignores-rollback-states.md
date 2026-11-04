----
description: Adding a CHECK or FOREIGN KEY constraint inside a transaction only checks the rows the transaction can see, so a row it deleted can come back on rollback and break the new rule. With CHECK the restored row can then vanish from queries that ask for it, because the optimizer trusts the constraint.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts  # rejectCheckViolatedByExistingRows: the engine's existing-row CHECK scan, shared by every module
  - packages/quereus/src/schema/constraint-builder.ts  # validateForeignKeyOverExistingRows, validateChecksOverExistingRows
  - packages/quereus/src/vtab/rollback-states.ts  # judgeRestorableStates, rolledBackRowsWouldViolate: the existing refusal for this class
  - packages/quereus-store/src/common/store-module-alter.ts  # alterAddConstraint: the unique arm judges rollback states, the foreignKey and check arms do not
  - docs/memory-table.md  # the rule for row-validating DDL and restorable states
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The CHECK scan is a generic engine query that cannot read a module's rollback states today, so the fix needs a new way to reach them, for a shape that requires deleting or overwriting a violating row and then adding the constraint in the same transaction.
----

# Adding a CHECK or FOREIGN KEY ignores the rows a rollback could restore

DDL survives a rollback on the bundled backends, while the rows it was judged against do not. For `create unique index`, `add constraint … unique`, `alter column … set collate`, `set data type` and `set not null`, the statement therefore also judges every state a rollback could restore, and refuses with `BUSY` ("Commit the pending writes first, then retry.") when one would break the new rule. `add constraint … check` and `add constraint … foreign key` do not do this.

## Reproduction

Run with the memory backend and with `using store` (no isolation wrapper), and the results were the same on both:

```sql
create table t (id integer primary key, v integer);
insert into t values (1, -1), (2, 5);
begin;
delete from t where id = 1;
alter table t add constraint pos check (v > 0);  -- accepted
rollback;
select * from t;               -- rows 1 and 2: row 1 breaks the surviving CHECK
select * from t where v <= 0;  -- empty: row 1 is not returned
```

The last query is the wrong result. `rejectCheckViolatedByExistingRows` documents why: the optimizer lifts a declared CHECK into a proven fact about every stored row, so a filter that contradicts it folds to nothing.

```sql
pragma foreign_keys = true;
create table p (id integer primary key);
create table c (id integer primary key, pid integer null);
insert into p values (1);
insert into c values (1, 99), (2, 1);
begin;
delete from c where id = 1;
alter table c add constraint fk foreign key (pid) references p (id);  -- accepted
rollback;
select * from c;               -- row 1 is back, an orphan under the surviving constraint
```

Not run: the isolation wrapper, and inline `check` on `add column`.

## Expected behavior

The same rule as the other row-validating DDL: a violation among the rows the transaction can see keeps `CONSTRAINT`, and a violation confined to a state a rollback could restore refuses with `BUSY`, leaving the transaction usable. `commit` followed by the same statement then lands the constraint.

A module that declares `permitsGrandfatheredCheckViolators` opts out of the CHECK half by its existing contract.
