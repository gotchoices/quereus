description: The two-side join DELETE fan-out's `mutual-fk-restrict-delete` plan-time reject is computed purely from the schema-declared mutual FK (`orderDeleteFanout` / `inboundDeleteAction` inspect only `TableSchema.foreignKeys`), independent of the rows the statement actually deletes. A view over a mutual-restrict (or restrict+cascade) FK pair whose join is on **non-FK columns**, where the specific joined rows do not in fact cross-reference via the FK at delete time (e.g. nullable FK columns left NULL), is now rejected at plan time even though the delete would have succeeded at runtime under the data. Decide whether the conservative over-rejection is acceptable, or whether the reject should be relaxed (e.g. only when lineage proves the join correlates the FK columns).
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Background

The ON-DELETE-aware fan-out ordering (ticket
`view-delete-fanout-mutual-fk-asymmetric-cascade-ordering`, completed) converts the
former "raw transitive-FK runtime error" for an unsatisfiable mutual-FK delete into a
structured `mutual-fk-restrict-delete` diagnostic raised at **plan time**, inside
`decomposeDelete` → `orderDeleteFanout`.

`orderDeleteFanout(sides)` → `inboundDeleteAction(child, parent)` derive the governing
ON DELETE action **solely** from the two base tables' declared `foreignKeys` (the same
schema-only predicate as `fkChildIndex`). They never consult:

- the view's **join predicate** (whether the join actually correlates the FK columns), nor
- the **rows** the statement selects (whether those specific rows cross-reference).

So the reject is **data-independent**: for any view over a mutual `restrict`/`restrict`,
`restrict`/`cascade`, or `cascade`/`restrict` FK pair, `delete from <view> where …` is
rejected up front regardless of the actual data.

## Why this is (usually) fine, and the one shape where it over-rejects

For the **common** view shape — a join *on the FK columns* (`… join b on b.aref =
a.aid` where `b.aref` is the FK to `a`) — every joined row references the other side by
construction, so deleting either side always trips the other's RESTRICT at runtime. The
plan-time reject exactly matches what the runtime would do, and replaces a cryptic raw
FK error with an actionable diagnostic. This is a strict improvement and is well covered
by the (fo-g)/(fo-h) goldens.

The over-rejection bites only when **both**:

1. the two base tables declare a **mutual** FK (each references the other — a cyclic
   schema, already rare), **and**
2. the view joins them on something **other** than the FK columns, **and** the specific
   joined rows do not actually cross-reference via the FK at delete time (e.g. the
   nullable FK columns are left NULL — MATCH SIMPLE means a NULL participates in no FK
   match, so the runtime RESTRICT pre-check would find no referencing row and succeed).

In that exotic shape the pre-change behavior was: fixed `[0, 1]` fan-out → runtime
RESTRICT pre-check examines the real data → **succeeds** (no referencing rows). The
post-change behavior **rejects at plan time**. That is a behavior regression for this
narrow case — a false-positive rejection.

## Repro sketch (to be fleshed out)

```sql
-- mutual restrict FK, but VIEW JOINS ON A NON-FK COLUMN (label), and the FK columns
-- (aref/bref) are left NULL so no row actually cross-references.
create table m_a (aid integer primary key, label text, bref integer null,
    foreign key (bref) references m_b(bid) on delete restrict);
create table m_b (bid integer primary key, label text, aref integer null,
    foreign key (aref) references m_a(aid) on delete restrict);
insert into m_a (aid, label, bref) values (1, 'x', null);
insert into m_b (bid, label, aref) values (10, 'x', null);
create view m_jv as select a.aid, b.bid from m_a a join m_b b on a.label = b.label;
delete from m_jv where aid = 1;   -- pre-change: succeeds (no FK refs). post-change: rejected with mutual-fk-restrict-delete.
```

(Confirm the exact pre/post behavior when picking this up; the join-on-non-FK lineage
path must still resolve to a two-side fan-out for the repro to reach `orderDeleteFanout`.)

## Options to weigh

- **(a) Gate the reject on FK-correlated lineage.** Only raise `mutual-fk-restrict-delete`
  when the view's join is proven to correlate the FK columns of the mutual edge (so the
  joined rows necessarily cross-reference). Otherwise fall back to the prior fixed-order
  fan-out and let the runtime RESTRICT pre-check decide on the real data. More precise,
  but needs join-predicate ↔ FK-column correlation analysis in the planner.
- **(b) Defer the decision to runtime entirely** for the non-FK-correlated case — i.e.
  keep the plan-time reject only for the FK-correlated common case.

Lean (a). Either way the resolution should be reflected in
`docs/view-updateability.md` § Inner Join — Deletes.
