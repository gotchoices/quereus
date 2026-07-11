----
description: Changing a column's declared type leaves the values already stored in it untouched, so those rows stop matching any query that filters on that column — they become effectively invisible while still counting toward the row total.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn, `change.setDataType` branch (~line 2049)
  - packages/quereus/src/runtime/emit/alter-table.ts    # runAlterColumn
difficulty: medium
----

# `alter column … set data type` does not convert the stored values

## Reproduction

Memory backend, no transaction involved, on `main` at the time of writing:

```sql
create table t (id integer primary key, v text);
insert into t values (1, '10'), (2, '9');
alter table t alter column v set data type integer;

select id, v from t;             -- 1|'10'  2|'9'   (still text)
select id from t where v = 9;    -- (no rows)
select id from t where v = '9';  -- (no rows)
insert into t values (3, 'abc'); -- rejected: Cannot convert 'abc' to INTEGER
```

New rows are type-checked against the new declared type. The rows that were already there are
neither converted nor reachable: they no longer match a comparison against a number (their value
is text), and they no longer match a comparison against text (the column's declared type is now
integer). They still show up in `select *` and in `count(*)`.

## What the code intends

`MemoryTableManager.alterColumn`'s `setDataType` branch does contain a conversion loop: when the
new type's physical representation differs from the old one it walks the base layer's rows,
converts each value, and writes the row back. The reproduction above shows the converted values
never reach a reader — either the loop is not entered for this type pair, or the rewrite does not
land where later reads look. Diagnosing which is the first step.

## Scope

Two adjacent, already-filed concerns are *not* this ticket:

- `bug-alter-column-changes-ignore-open-transaction` covers the same statement's failure to see
  or update an open transaction's uncommitted rows. This ticket is about the plain autocommit
  case, where no transaction is involved.
- Whatever fixes the conversion must also refresh any secondary index on the column: index keys
  are extracted from the row when it is written, and nothing in the `setDataType` branch rebuilds
  them after the values change. The `set not null` branch, which backfills `NULL`s from the column
  default, has the same gap and does not depend on this bug — it was noticed here but not
  separately reproduced.
