description: `x in (insert ... returning ...)` works out its answer for the first outer row and reuses that answer for every other row, so a query over more than one row returns the wrong rows.
files:
  - packages/quereus/src/runtime/emit/subquery.ts   # runImpure in emitIn
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic   # section 2 covers one probe value only
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Membership tests over a data-changing subquery are rare, and existing tests only use one probe value, so a maintainer could reasonably defer this, although the wrong rows come back silently.
----

An `IN` whose right side changes data must run that statement exactly once per execution. `runImpure` in `emitIn` does this by remembering a result for the whole execution, but what it remembers is the true/false/NULL answer for the first probe value, not the set of values the statement returned. Every later outer row gets the first row's answer whatever its own value is.

Reproduced on the memory module, on plain INTEGER and TEXT columns. This does not depend on any type conversion:

```sql
create table n (id integer primary key, i integer null);
insert into n values (1, 10), (2, 20);
create table w (k integer primary key, v integer null);

select id from n where i in (insert into w values (1, 10) returning v);
-- returns ids 1 and 2; should return only id 1

create table tt (id integer primary key, s text null);
insert into tt values (1, 'a'), (2, 'b');
create table w2 (k integer primary key, v text null);

select id from tt where s in (insert into w2 values (1, 'b') returning v);
-- returns no rows; should return id 2
```

Expected behaviour: the statement still runs once per execution and drains fully, and each outer row is tested against the values it returned, with the same NULL handling as any other `IN`. The existing tests pass one constant probe (`select 1 in (insert ...)`), which is why this has not shown up.
