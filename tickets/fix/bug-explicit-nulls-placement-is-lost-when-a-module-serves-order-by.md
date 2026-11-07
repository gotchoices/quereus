description: `order by s nulls last` can return the NULLs first when a table module says it can deliver the rows in order, because one of the planner's two routes for dropping a sort ignores the requested NULL placement. Memory tables happen to avoid it on 5.0.0, but any module that claims the ordering gets wrong results.
architecture: docs/optimizer-retrieve.md#dynamic-support-growth-with-rulegrowretrieve
files: packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (the `PlanNodeType.Sort` arm that calls `extractOrderingFromSortKeys`, and `trySortAbsorbViaIndexOrdering`'s explicit-NULLS refusal), packages/quereus/src/planner/framework/physical-utils.ts (`extractOrderingFromSortKeys`)
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids this by never claiming an ordering over a nullable column, and keeps its own copy as a blocked ticket, `quereus-explicit-nulls-placement-is-lost-when-an-index-serves-order-by`.

## What goes wrong

Measured on 4.25.0 with a plain memory table:

```sql
create table t (id text primary key, s text null);
create index t_s on t (s);
insert into t values ('1','b'), ('2',null), ('3','a');
```

| statement | plan | returned | correct |
|---|---|---|---|
| `select s from t order by s nulls last` | `INDEXSCAN` | null, a, b | a, b, null |
| `select s from t order by s nulls first` | `INDEXSCAN` | null, a, b | null, a, b |
| `select s from t order by s` | `INDEXSCAN` | null, a, b | null, a, b |

On 5.0.0 the memory table returns a, b, null, but only because the plan now keeps a `SORT` above the `INDEXSCAN`. The Sort arm below is unchanged from 4.25.0, so a module that answers the ordering request with a matching ordering still has its Sort removed. To reproduce on 5.0.0, use a test module whose `getBestAccessPlan` claims any `requiredOrdering` over an index on `s`.

## Cause

Read from the code, not confirmed by applying the change. `trySortAbsorbViaIndexOrdering` refuses a sort key with explicit `nulls` ("Explicit NULLS FIRST/LAST is not currently propagated to the access plan — refuse to absorb"). The other route does not: the `PlanNodeType.Sort` arm of the index-style fallback in `rule-grow-retrieve.ts` builds `request.requiredOrdering` from `extractOrderingFromSortKeys`, whose parameter type has no `nulls` field. The module answers with an ordering that matches, and the Sort goes.

## Proposed change

In that Sort arm, refuse as the absorb path does, before extracting the ordering:

```ts
if (sort.getSortKeys().some(key => key.nulls)) {
	log('Sort key has explicit NULLS; cannot translate to an ordering spec');
	return undefined;
}
```

Add the table above as a logic test over a module that claims orderings, plus `desc nulls last` on a NOT NULL column to confirm a placement that cannot matter still plans correctly. Dropping an explicit placement on a NOT NULL column before planning, so such a query keeps its index, is a later optimization and not part of this fix.

Longer term, `OrderingSpec.nullsFirst` exists on the request but nothing in the planner fills it; filling it would let a module serve an explicit placement instead of declining.

## If nothing is done

Wrong order for any module that claims an ordering over a nullable column. Columns are NOT NULL by default, so the common case is unaffected.
