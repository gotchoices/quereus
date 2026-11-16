description: Inserting through a view built on a join with "or ignore" or "or fail" can write one table's half of a row and drop the other half, leaving an orphaned row that the view no longer shows. A rejected row should be skipped (or stopped) as a whole.
architecture: docs/vu-operators.md
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/vu-operators.md, docs/lens-constraints.md
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: A plain `insert` (abort) is atomic already and is what most writers use; making each logical row all-or-nothing needs a per-row savepoint or a pre-check across sides, which costs per-row work on every conflict-clause insert through a join.
----

# Join-view insert with `or ignore` / `or fail` keeps half a row

## What goes wrong

An insert through a join view fans out into one insert per joined table, run one after another, each with the statement's conflict clause. Under `or ignore`, a row that one table rejects is skipped **on that table only**: the tables already inserted for that row keep their row. Under `or fail`, the statement stops, but the earlier tables' part of the failing row stays written. Either way a basis row is left with no partner, so the logical row is half-written: an inner-join view does not show it at all, and an outer-join view shows it with the rejected side's columns as NULL.

Observed (Quereus, 2026-11-16) with a plain view, no lens involved:

```sql
create table Core (id integer primary key, name text null);
create table Contact (id integer primary key references Core(id), mail text null check (mail like '%@%'));
create view V as select c.id, c.name, k.mail as email from Core c join Contact k on c.id = k.id;

insert or ignore into V values (1, 'a', 'nope'), (2, 'b', 'b@c');
select * from V;     -- [(2, 'b', 'b@c')]
select * from Core;  -- [(1, 'a'), (2, 'b')]   ← row 1 is orphaned

insert or fail into V values (3, 'a', 'nope');  -- fails, as it should
select * from Core;  -- now also holds (3, 'a')
```

The same thing happens through a join-backed logical table (an application-schema table declared with `declare lens … as select … from y.Core c join y.Contact k …`), now that its insert enforces the table's rules on each side (`bug-join-backed-logical-table-enforces-no-rules-on-insert`): a `check (email like '%@%')` that rejects the Contact half under `or ignore` leaves the Core half behind. Under a left join the row stays visible with `email` NULL, so the supplied value is silently dropped instead of the row being skipped.

## Expected

A conflict clause applies to the **logical row**: `or ignore` skips every table's part of a rejected row, and `or fail` leaves none of the failing row's parts written (earlier rows keep their changes, as `or fail` specifies). `insert` / `or abort` / `or rollback` are already atomic, because the whole statement or transaction is undone.

## Notes for whoever picks this up

- The fan-out is `buildMultiSourceInsert` in `view-mutation-builder.ts` (each side built through the ordinary base-table insert builder with the statement's `onConflict`), driven side by side by the view-mutation emitter.
- Envelope row checks (`MutationEnvelope.rowChecks`, evaluated in `runtime/emit/view-mutation.ts` before any side insert) already skip a whole logical row under `or ignore`; they cover only checks the envelope can evaluate, not a side's unique / primary-key / foreign-key conflicts, so they are not the general answer.
- Not checked: whether the decomposition insert fan-out (`buildDecompositionInsert`) has the same gap for a basis-level conflict on a member. It also fans out one insert per member under the statement's clause, so it likely does; check it with the same scenario against a decomposition-backed table.
