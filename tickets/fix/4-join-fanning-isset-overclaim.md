description: A fanning (non-1:1) inner/cross join of two sets is over-claimed a *set* by `buildJoinRelationType` — `isSet` is derived from `leftType.isSet && rightType.isSet` without proving the join is row-preserving. Every consumer that trusts `isSet`/`keysOf` (DISTINCT-elimination, ORDER-BY FD-pruning, GROUP-BY FD-simplification, and now the materialized-view full-rebuild floor) treats a bag as a set. The MV floor accepts such a body and silently collapses the duplicates its all-columns backing key cannot hold, diverging from the equivalent plain view.
files: packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts
----

## The bug

`buildJoinRelationType` (`packages/quereus/src/planner/nodes/join-utils.ts:118`) computes:

```ts
const isSet = (joinType === 'inner' || joinType === 'cross') &&
    leftType.isSet && rightType.isSet;
```

This says *a join of two sets is a set* — which is false for a **fanning** join. When the
equi-join key is non-unique on the matched side, one row joins many, so the output has duplicate
rows and is a **bag** even though both inputs are sets. `keysOf` (`fd-utils.ts`, the
`isSet`-gated all-columns fallback at ~line 808) then advertises an all-columns key for the
over-claimed set, so the body looks keyed when it is not.

This is exposed (not caused) by the materialized-view eligibility flip
(`mv-eligibility-floor-fallthrough`): fanning joins now route to the full-rebuild floor, whose
bag reject (`buildFullRebuildPlan`, `keysOf(root).length === 0`) is the *only* thing standing
between an unkeyed body and a silently-deduplicating materialization. Because `isSet` lies, the
bag reject is bypassed.

## Reproduction (confirmed)

```sql
create table g  (id integer primary key, k integer, v integer);
create table g2 (id integer primary key, w integer);
insert into g values (1, 100, 5);
-- g2 has no matching row yet, so the create-fill yields 0 rows (trivially distinct) and the
-- body reaches the gate; the floor accepts it because the optimizer marks the join a set.
create materialized view bj as select g.id, g.v from g join g2 on g.k = g2.w;   -- ACCEPTED (bug)

insert into g2 values (10, 100), (20, 100);   -- g.k=100 now matches TWO g2 rows → body fans to 2 rows
```

After the fan-out:
- `select id, v from bj` → `[{id:1, v:5}]`  (1 row — the all-columns backing key collapsed the duplicate)
- the equivalent plain `view` of the same body → `[{id:1, v:5}, {id:1, v:5}]`  (2 rows)

The materialized view silently diverges from its definition.

## Expected behavior

An inner/cross join of two sets is a **set** only when it is provably **row-preserving** (no
fan-out): the equi-join condition's columns on at least one side must cover a **unique key of the
other side**, so each row of that side matches at most one row. Otherwise `isSet` must be `false`,
`keysOf` must yield no all-columns fallback, and the body is correctly a **bag**.

With `isSet` corrected, the fanning-join repro above routes through the floor's existing
`no-provable-unique-key / must-be-a-set` **bag reject** at create — the sound outcome under the
cost-gated-with-floor model (a bag has no row identity to materialize on). A future enhancement
could *materialize multiplicity* for bag bodies instead of rejecting (see the MV future-enhancements
backlog), but that is out of scope here; the correctness fix is to stop over-claiming `isSet`.

The 1:1 proof the MV join-residual arm already carries (`buildJoinResidualPlan` in
`database-materialized-views.ts` — its `proveJoinOneToOne`/`proof.ok` machinery: NOT-NULL FK from the
driving side to the lookup PK, lookup join key covers the lookup unique key) is the same
row-preserving property the `isSet` inference needs; factor or mirror it so the two cannot drift.

## Blast radius

`isSet`/`keysOf` is trusted broadly — this is an optimizer-core fix, not an MV-local one:
- `rule-distinct-elimination.ts` — must NOT eliminate a `distinct` over a fanning join (it would
  change multiplicity).
- `rule-orderby-fd-pruning.ts`, `rule-groupby-fd-simplification.ts` — must not treat the fanning
  join's all-columns "key" as a real key.
- the MV full-rebuild floor — the reproduction above.

So the fix needs the **full** suite (`yarn test`) plus the optimizer/plan suites green, and a
focused regression that a `distinct`/`group by` over a fanning join is not simplified away.

## Use cases to lock in

- **Fanning join is a bag**: the reproduction MV rejects at create with the no-provable-unique-key
  diagnostic (move it from any equivalence-harness zoo into the diagnostics reject spec).
- **Provably-1:1 FK join is still a set**: the `ok_join_where` / `ok_join_outer` bodies in
  `53-materialized-views-rowtime.sqllogic` § 7 and the join-residual arm's covered shapes must
  keep their set/keyed status (no regression — a true 1:1 join of two sets stays a set).
- **Self-join / pk=pk join**: confirm the `isSet` result matches actual multiplicity for a
  key-equi-join (1:1) vs a non-key-equi-join (fanning).
- **DISTINCT / GROUP BY over a fanning join**: not eliminated/simplified by the FD rules.

## Relationship to other tickets

- Exposed by `mv-eligibility-floor-fallthrough` (the floor now routes fanning joins instead of
  shape-rejecting them).
- **Blocks** `mv-comprehensive-coverage-net` (ticket 6): its equivalence-harness zoo lists a
  "fanning (non-1:1) inner join" asserting `read(MV) == evaluate(body)`, which **cannot hold**
  until this lands. After the fix the fanning join is a *reject*, so ticket 6 should test it in the
  diagnostics reject spec, not the equivalence zoo (consistent with ticket 6's own
  "bag body is a reject, not an equivalence case" note).
