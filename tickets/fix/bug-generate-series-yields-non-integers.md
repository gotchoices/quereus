description: The built-in generate_series table function says its output column holds integers, but given a fractional start it produces fractional values (0.5, 1.5, …), and given very large integer bounds it produces imprecise ones. Any module that relies on the declared type to look values up by key either errors or, if it did not check, would return the wrong rows.
files:
  - packages/quereus/src/func/builtins/generation.ts   # generateSeriesFunc: declares `value` INTEGER_TYPE; the generator runs `Number(start)` and yields `i` unconverted
  - docs/functions.md                                  # ~:675 "Generates integers from start to stop"
  - docs/sql-functions.md                              # ~:354 same claim
repro: verified
----

Filed from the lamina board while reviewing lamina slug `claim-correlated-seek-keys`.

## What happens

`generate_series(start, stop)` declares one output column, `value`, as `INTEGER_TYPE` (non-null). The generator body is:

```ts
const startNum = Number(start);
const endNum = Number(end);
if (isNaN(startNum) || isNaN(endNum)) return;
for (let i = startNum; i <= endNum; ++i) yield [i];
```

So:

- a fractional `start` yields fractional values: `generate_series(0.5, 3)` yields `0.5, 1.5, 2.5`, each a non-integer JS `number` in a column declared INTEGER;
- a `bigint` bound past ±(2^53 − 1) is narrowed by `Number(...)`, so the series is computed in floating point and yields `number`s outside the safe-integer range, where the representation rule requires a `bigint` (and `++i` stops changing the value once past 2^53, so the loop can also fail to terminate for a large enough `stop`).

Both break the physical-representation rule Quereus states for every value in a column of a declared type (a value inhabits its declared type's JS value space; a whole number is a `number` inside ±(2^53 − 1) and a `bigint` outside it).

## Why it matters

Consumers trust a column's declared type. Lamina claims `inner.key = outer.col` (and `<`, `<=`, `>`, `>=`) as an index seek when the outer column's declared type fits the inner key's kind, and checks every value before seeking; a value that contradicts its declared type fails the query instead of seeking a truncated key. With `@quereus/quereus` 4.20.2 under lamina:

```sql
create table ip (pid integer primary key, name text);
insert into ip values (1, 'one'), (2, 'two'), (3, 'three');
select g.value, (select count(*) from ip p where p.pid < g.value) from generate_series(0.5, 3) g;
-- lamina: error "seek value for column 'pid' (int) is a non-integer number, which contradicts its declared SQL type"
-- memory module: [[0.5,0],[1.5,1],[2.5,2]]
```

The same happens for `p.pid = g.value` and for `join ip p on p.pid = g.value`. A module that did not check would seek `1` for `1.5` and return wrong rows. `QUEREUS_REPR_STRICT=1` does not catch it today, because table-valued-function output is not one of the asserted seams.

## Expected behavior

Every value `generate_series` yields inhabits INTEGER's value space. Which of these is right is a decision for this board:

- reject (or truncate, as `cast(x as integer)` would) a non-integer `start` / `stop`;
- iterate in the integer domain, yielding `number` inside the safe range and `bigint` outside it;
- or, if fractional series are wanted, declare the column REAL (or ANY) when the bounds are not integers — a plan-time type cannot depend on runtime bounds in general, so this one is probably not available.

The docs (`functions.md`, `sql-functions.md`) already promise integers. `sql-functions.md` also lists an optional `step` argument the function does not accept (`numArgs: 2`); worth reconciling while there.
