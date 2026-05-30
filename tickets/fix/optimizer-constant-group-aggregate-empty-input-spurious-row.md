description: A multi-column `group by` whose group columns are all equality-pinned to constants is mis-collapsed into a scalar aggregate, so over an empty input it returns one spurious all-NULL `count=0` row instead of zero rows. Single-column group-by is correct. Wrong query results; surfaced while building the residual-recompute materialized-view arm.
files: packages/quereus/src/planner/, packages/quereus/test/logic/
----

# Constant-pinned multi-column `group by` returns a spurious row over empty input

## Symptom

A grouped aggregate whose **GROUP BY columns are all constrained to constants** by an
equality `WHERE` is rewritten by the optimizer into a **scalar** (no-GROUP-BY) aggregate.
A scalar aggregate emits exactly one row over an empty input (`count = 0`, group columns
NULL), but the correct grouped result over an empty input is **zero rows**.

This is a **correctness bug** (wrong result rows), not just a plan-shape quirk.

## Reproduction (plain queries, no materialized view)

```sql
create table t (id integer primary key, a integer, b integer, k integer);
insert into t values (2, 3, 4, 2), (3, 7, 1, 9);   -- no row has a=0, k=6

-- TWO equality-pinned group columns → WRONG (collapses to scalar aggregate):
select a, k, count(*) as c, sum(b) as s from t where a = 0 and k = 6 group by a, k;
--   actual:   [{a:null, k:null, c:0, s:null}]
--   expected: []   (no rows match → no groups → no output rows)

-- ONE equality-pinned group column → CORRECT:
select k, count(*) as c, sum(a) as s from t where k = 6 group by k;
--   actual & expected: []
```

The bug reproduces identically with bound parameters (`where a = :p0 and k = :p1`), so it
is the constant/equality-determined group key, not literal folding specifically, that
triggers the collapse.

## Expected behaviour

`select … group by g1, g2 [, …]` must return **one row per group actually present in the
(post-WHERE) input**. When the input is empty, the result is empty — regardless of how
many group columns are functionally constant. The grouped→scalar rewrite is only valid
when GROUP BY is genuinely absent, or as an optimization that **preserves the
zero-rows-over-empty-input semantics** (i.e. it must still produce no row when no input
row exists).

## Likely cause

A rule that recognizes the GROUP BY columns as functionally constant (pinned by the
equality predicate) and eliminates the GROUP BY / rewrites the aggregate to a
single-group form. The single-group form unconditionally emits one row, which is correct
only for a true scalar aggregate (`select count(*) from t`), not for a grouped query
whose sole group may have zero members. The single-column path does not hit this rewrite,
which is the clue for locating it (`planner/rules/aggregate/` and the aggregate
FD/constant-binding propagation, `propagateAggregateFds` / `projectConstantBindings`).

## Impact / current mitigation

Surfaced by `materialized-view-rowtime-residual-recompute`: an emptied **multi-column**
group's key-filtered residual hit this collapse and re-upserted a spurious backing row.
That arm now filters residual rows to those whose backing key equals the affected key
(`residualRowMatchesKey` in `database-materialized-views.ts`), which masks the bug for
that consumer **only because the spurious row carries NULL group columns**. The
underlying wrong-results bug remains for direct user queries and should be fixed at the
optimizer; once fixed, the MV filter becomes a harmless no-op (it is a sound invariant
regardless).

## Suggested regression test

Add to `test/logic/` (e.g. an aggregate logic file): the two queries above, asserting the
multi-column constant-pinned empty-match case returns `[]`, plus a non-empty multi-column
case (`where a = 3 and k = 9` → exactly one group row) to confirm the fix doesn't regress
the non-empty path.
