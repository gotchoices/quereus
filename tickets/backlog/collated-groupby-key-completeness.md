description: Completeness gap — GROUP BY over a collate-wrapped expression produces no key claim, though the group columns genuinely key the output under the output collation. `select b collate nocase as g, count(*) from t group by b collate nocase` yields keysOf = [] (and so cannot back a materialized view), even though the output is a set keyed on {g} under NOCASE.
files:
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
----

# Collated GROUP BY should claim its group key

Observed (fix-stage probe, ticket `collation-weakening-key-claims`): over
`create table t (b text primary key)` with `'Bob'`,`'bob'`,

```sql
select b collate nocase as g, count(*) as n from t group by b collate nocase
```

returns one row (`g='Bob', n=2` — grouping correctly compares NOCASE) but
`keysOf(root)` is `[]` and the output column's collation is NOCASE.

The claim `{g}` *is* sound here: grouping dedups under exactly the collation
the output column publishes, so consumers that interpret keys under output
collations (DISTINCT elimination above it, MV backing PK, join cardinality)
would all be correct. The key is lost because the group-expression →
output-column mapping presumably rides the same projection-map machinery that
(deliberately, for soundness) excludes `CollateNode`.

Soundness condition to respect when fixing: the claimed key's columns must be
published with a collation **at least as coarse as** the grouping comparison's
collation (they match exactly in the natural shape above). A group key claimed
onto an output column republished *finer* than the grouping collation would
over-claim.

Use case beyond optimization: a collated GROUP BY body is a legitimate keyed
set, so this fix would let
`create materialized view m as select b collate nocase as b from t group by b collate nocase`
materialize with a real (non-coarsened) key — complementary to the
coarsened-key path in implement ticket `mv-coarsened-backing-key-warning`,
which remains necessary for multi-column passthrough bodies.
