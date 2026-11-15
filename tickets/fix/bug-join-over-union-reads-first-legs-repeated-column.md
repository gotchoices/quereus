---
description: A query that joins a table to a union returns wrong rows, with no error, when the union's first branch selects the same column twice. Rows from the other branch come back with one of their two columns overwritten by the other.
repro: verified
---

# A join over a union reads a later leg's columns as equal when the first leg repeats a column

Filed from the SiteCAD board (its `tickets/blocked/quereus-join-over-a-union-returns-wrong-rows-and-views-take-writes.md`), found while designing a view of that shape. SiteCAD avoids the shape and nothing there waits on this.

## Reproduction

Verified on `@quereus/quereus` 5.4.0 with memory-backed tables in a bare `Database`, 2026-11-14. Not tried over any other module.

```sql
create table A (id integer primary key);
create table B (id integer primary key, a_id integer);
create table K (id integer primary key);
insert into A values (1);
insert into B values (2, 1);
insert into K values (1);

-- the union alone is right
select id as x, id as y from A union all select id as x, a_id as y from B order by 1;
-- (1, 1), (2, 1)

-- joined, the row from B is wrong
select u.x, u.y
from (select id as x, id as y from A union all select id as x, a_id as y from B) u
join K k on k.id = u.y
order by 1;
-- got      (1, 1), (1, 1)
-- expected (1, 1), (2, 1)
```

The row that comes from `B` is returned with `x` equal to `y`: its `x` (2) is replaced by its `y` (1).

## Which shapes are affected

Same data, same derived table `u`, each run once:

| Query over `u` | Result | |
|---|---|---|
| `join K k on k.id = u.y` | (1,1), (1,1) | wrong |
| `left join K k on k.id = u.y` | (1,1), (1,1) | wrong |
| plain `union` in place of `union all`, inner join | (1,1), (1,1) | wrong |
| the same body as `create view V as …`, then `V v join K k on k.id = v.y` | (1,1), (1,1) | wrong |
| `where u.y in (select id from K)` | (1,1), (2,1) | right |
| `where exists (select 1 from K k where k.id = u.y)` | (1,1), (2,1) | right |
| `where u.y = 1` | (1,1), (2,1) | right |
| the same body as a `with u as (…)` CTE, inner join | (1,1), (2,1) | right |
| first leg written `select id + 0 as x, id as y from A` | (1,1), (2,1) | right |
| the legs swapped, `B`'s leg first | (1,1), (2,1) | right |

The SiteCAD report says the `in (…)` and `exists` forms also returned wrong rows in its probes, on larger data; with the six rows above they are right. Treat those two as unconfirmed, and try them at more than one row per table.

## Likely cause (a guess, not read from the source)

Every wrong case has a first leg whose two output columns are the same source column, and a join on one of them. Making the first leg's columns different expressions (`id + 0`) or putting the other leg first makes the result right. That is what one would see if a fact true of the first leg alone, "these two output columns are equal", were attached to the union's output and the join then read one column for the other. The plan for the joined query is the place to look for the two output columns being treated as one.

It looks like the same family as the recursive-query defect fixed in 5.2, where a start row selecting one column twice made the recursive step's first output column read as the second.

## Expected

A set operation's output columns carry only what holds for every leg. The joined queries above return (1, 1), (2, 1).

## Why it matters to a host

The wrong rows come back with no error, from SQL that reads as ordinary: "everything of kind A, plus everything in B that points at one" joined to a third table. SiteCAD's library operations are written in SQL and use unions of this shape.
