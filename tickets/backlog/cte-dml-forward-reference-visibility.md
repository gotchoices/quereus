----
description: A CTE-name DML target whose body reads a sibling CTE defined LATER (whose name also shadows a real base table) rejects (`CTEReference … not updateable`) instead of writing through to the real table, because the CTE-target re-plan threads ALL siblings into scope rather than only the target's prior siblings. Make the re-plan context respect per-CTE definition-order visibility.
difficulty: hard
files:
  - packages/quereus/src/planner/building/dml-target.ts          # contextForCteTarget — currently removes only the target's own name from cteNodes
  - packages/quereus/src/planner/mutation/cte-flatten.ts          # flattener already respects prior-sibling-only visibility (ctesBefore)
  - packages/quereus/src/planner/building/with.js                 # buildCommonTableExpr — how a CTE body is built against PRIOR siblings only (the read-path analog to mirror)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # the current reject boundary test (search: "FORWARD reference")
----

# CTE-name DML target: forward-reference shadowing a real table

## Current behavior (a v1 boundary)

```sql
create table fwd (id integer primary key, color text);
insert into fwd values (1,'red');
with x as (select id, color from fwd), fwd as (select id, color from fwd)
    update x set color='z' where id=1;
-- error: is not updateable in phase 1  (CTEReference)
```

Per SQL scoping, `x`'s `from fwd` should bind the **real** base table `fwd` — a
non-recursive CTE is visible only to *later* siblings and the main query, so the
later `fwd` CTE is out of scope inside `x`. The statement should therefore write
through to the real `fwd` table.

It rejects instead. The flattener (`cte-flatten.ts`) is correct here: it treats
`x`'s body as terminal (only `ctesBefore` — prior siblings — are inlinable, and
`x` has none). The reject originates in the **re-plan context**:
`contextForCteTarget` removes only the *target's own* name from `cteNodes` and
leaves every other sibling — including the later `fwd` — in scope. So when the
ephemeral body `select id, color from fwd` is re-planned, `buildFrom` resolves
`fwd` against `cteNodes` (which still holds the later CTE), reaching a
`CTEReferenceNode` → `no-base-lineage`.

Not silently wrong — it is a clean reject, never a write to the wrong table.

## Desired behavior

The re-plan of a CTE-name target's body should see only the target's **prior**
siblings in `cteNodes` (mirroring `buildCommonTableExpr`, which builds each CTE
body against the prior siblings only). Then a forward-referenced name that also
names a real table resolves to the real table, and the write goes through.

## Notes / scope

- This is independent of the multi-level flattener — it is a property of the
  re-plan `PlanningContext` construction. Fixing it generalizes to single-level
  CTE targets too (any target whose body names a later-defined sibling).
- `contextForCteTarget` currently takes only the target name. A per-target
  prior-sibling prefix is needed (the WITH clause + the target's index), so the
  signature and its callers in the view-mutation builder change.
- The current reject is pinned by a boundary test in
  `93.4-view-mutation.sqllogic` (comment: "FORWARD reference"); flip it to a
  positive write-through assertion when this lands.
