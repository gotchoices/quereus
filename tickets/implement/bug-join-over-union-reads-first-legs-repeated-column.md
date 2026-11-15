---
description: A query over a union returns wrong rows, with no error, when the union's first branch selects the same column twice — the other branch's rows come back with one column overwritten by the other. Fix it where a projection hands out its column identifiers, so one projection can never give two output columns the same identifier.
architecture: docs/optimizer.md#attribute-provenance
files: packages/quereus/src/planner/nodes/project-node.ts (attributesCache in the constructor, both branches), packages/quereus/src/planner/analysis/attribute-provenance.ts (computeAttributeProvenance), packages/quereus/src/planner/nodes/recursive-cte-node.ts (buildAttributes NOTE), packages/quereus/src/planner/nodes/set-operation-node.ts (buildAttributes — reads only, no change expected), packages/quereus/src/util/row-descriptor.ts (buildRowDescriptor — why a repeated id reads one slot), packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic, packages/quereus/test/planner/attribute-provenance.spec.ts, docs/optimizer.md, docs/invariants.md (OPT-014)
repro: verified
---

# A projection publishes one column identifier at two output positions

Filed from the SiteCAD board. Reproduced on the current tree (built `dist`, memory tables, 2026-11-14).

## Cause

The planner names each column by a numeric attribute id, and the runtime finds a column's value by mapping that id to a slot in the row (`buildRowDescriptor` in `src/util/row-descriptor.ts`: `descriptor[attr.id] = index`, so if an id appears twice, the last position wins).

`ProjectNode` keeps the source column's id for a bare column reference (`project-node.ts`, the `attributesCache` builder, the `proj.node instanceof ColumnReferenceNode` branch). So `select id as x, id as y from A` publishes the same id (12 in the plan dump) at positions 0 and 1. On its own this does no harm, because both positions hold the same value.

`SetOperationNode.buildAttributes` publishes the left branch's ids as the union's output ids. So the union's `x` and `y` are both id 12, even though rows from the right branch (`select id, a_id from B`) have different values in the two positions. Any reader above the union that resolves `x` by id gets slot 1 (`y`).

`query_plan` of the join query shows both outer column references `u.x` and `u.y` with `attributeId: 12`. The union drops the branches' functional dependencies and equality facts (`SetOperationNode.computePhysical` returns `fds`/`equivClasses` as `undefined`), so the ticket's guess that the left branch's "x = y" fact leaks is wrong. The cause is only the shared id.

This is the same defect as the recursive-CTE one fixed in `recursive-cte-repeated-start-column-read-as-twin` (start row `select id, id`). That fix minted fresh ids at the one consumer (the working-table reference). This ticket fixes it where the repeated id is created, so every consumer is covered.

## Which shapes are wrong (more than the ticket listed)

Derived table `u` = `(select id as x, id as y from A union all select id as x, a_id as y from B) u`, data A(1), B(2,1), K(1):

| Query | Got | Expected |
|---|---|---|
| `select u.x, u.y from u join K k on k.id = u.y` | (1,1),(1,1) | (1,1),(2,1) |
| `select u.x, u.y from u cross join K k` | (1,1),(1,1) | (1,1),(2,1) |
| `select u.x from u` | 1, 1 | 1, 2 |
| `select u.x, u.y from u where u.x = 2` | no rows | (2,1) |
| `select count(*), u.x from u group by u.x` | one group (2, x=1) | two groups |
| `select u.x, u.y from u where u.y = 1` | right | — |
| `select u.x, u.y from u where u.y in (select id from K)` | right | — |
| the compound select alone, `order by y, x` | right | — |

`where u.y = 1` is right only by luck: the outer projection is removed as an identity, and the filter reads id 12 from slot 1, which is `y`. So the true trigger is not "a join". It is any reader above the union that resolves the first of the repeated columns by id.

## Fix (verified by a temporary patch to the built `dist`, since reverted)

In `ProjectNode`'s attribute builder, keep a set of the ids already published by this projection. The first output position that forwards a given id keeps it. Any later position that would publish the same id gets `PlanNode.nextAttrId()` instead. Apply this to all three id sources in the builder:

- the `proj.attributeId !== undefined` branch (optimizer-supplied ids),
- the bare `ColumnReferenceNode` branch,
- the `!this.preserveInputColumns` branch (`proj.attributeId ?? PlanNode.nextAttrId()`).

The temporary patch covered the first two. With it, every wrong row in the table above came back right, and the right ones stayed right, including `order by y, x` on the compound select. The ids stay stable across optimizer rewrites: `withChildren` and `withProjections` rebuild from `getAttributes()`/`getProjections()`, which already carry the deduplicated ids, and the predefined-attributes path takes them verbatim.

The first position keeps the source id, so an `order by` written against the underlying source column still resolves to position 0, the same as today.

Keep this as a small helper (for example `uniqueOutputId(seen, id)`), not inline code repeated three times. The constructor comment on `sourceTypeById` ("collision-free — attribute ids are globally unique") stays true.

## Boundary check (the invariant is already documented)

`docs/invariants.md` OPT-014 and `docs/optimizer.md` § Attribute provenance already state that "one node listing an ID twice is a genuine bug" and throws. `computeAttributeProvenance` only enforces that for ids the node originates, though: forwarded ids are `continue`d before the duplicate check. So the projection above, which forwards id 12 twice, passes. Extend the walk so that any relational node listing one id at two positions throws `QuereusError(INTERNAL)`, whether the id is forwarded or originated. The existing message, `Duplicate attribute ID … within the output of …`, fits.

The validator runs only under the `validate_plan` option (off by default, and not turned on by the test runner), so this check guards debugging and its spec, not production. Before landing it, temporarily flip `validate_plan`'s default to `true` in `src/core/database.ts`, run `yarn workspace @quereus/quereus test`, and look for new `Duplicate attribute ID` failures, then revert the flip. A failure there is either another node family that repeats ids (Returning with `returning id, id`, the aggregate builders that pass `colRef.attributeId` in `select-aggregates.ts`, a join over one shared subtree instance on both sides). Fix it at that node the same way if it is real. If it is a legitimate shape, narrow the check and leave a `NOTE:` saying why. Don't keep the default flipped.

## Reproduction test

Add to `packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic`, in its own section before the cleanup block, and drop the tables in cleanup. It fails today with `[{"x":1,"y":1},{"x":1,"y":1}]` and `[{"x":1},{"x":1}]`.

```sql
-- ============================================================
-- SET OPERATIONS: first branch selects one column twice
-- ============================================================
-- The union's output columns must stay distinct when the first branch repeats a column;
-- a reader above the union used to read x as y for the other branch's rows.

CREATE TABLE sose_ra (id INTEGER PRIMARY KEY);
CREATE TABLE sose_rb (id INTEGER PRIMARY KEY, a_id INTEGER);
CREATE TABLE sose_rk (id INTEGER PRIMARY KEY);
INSERT INTO sose_ra VALUES (1);
INSERT INTO sose_rb VALUES (2, 1);
INSERT INTO sose_rk VALUES (1);

select u.x, u.y
from (select id as x, id as y from sose_ra union all select id as x, a_id as y from sose_rb) u
join sose_rk k on k.id = u.y
order by 1;
→ [{"x":1,"y":1},{"x":2,"y":1}]

select u.x
from (select id as x, id as y from sose_ra union all select id as x, a_id as y from sose_rb) u
order by 1;
→ [{"x":1},{"x":2}]
```

Two queries, because they fail through different readers (a join row versus a plain projection). Don't add one per row of the table above.

## TODO

- In `project-node.ts`'s attribute builder, make a repeated id at a later output position mint a fresh id in all three branches, through one small helper.
- Add the reproduction section above to `28-set-ops-sort-edge-cases.sqllogic` and confirm it fails before the fix and passes after.
- Extend `computeAttributeProvenance` to throw when one node's output lists an id twice, forwarded or not. Add one case to `test/planner/attribute-provenance.spec.ts` (a node forwarding one child id at two positions throws). Do the temporary `validate_plan`-on full run described above, then revert the flip.
- Update the `NOTE:` in `recursive-cte-node.ts` `buildAttributes`. A base case can no longer repeat an id, so the tripwire's premise is gone. Leave `workingTableAttributes` in `with.ts` alone, since it has a second reason (keeping the recursive step's reads off the start row's scan slots).
- Docs: in `docs/optimizer.md` § Attribute provenance and `docs/invariants.md` OPT-014, say that `ProjectNode` forwards a source id only at its first output position and mints fresh ids for repeats, and that the provenance walk now rejects any node listing an id twice, forwarded ones included.
- Run `yarn workspace @quereus/quereus lint` and `yarn workspace @quereus/quereus test`. The change is planner-only, so `test:store` is optional.
