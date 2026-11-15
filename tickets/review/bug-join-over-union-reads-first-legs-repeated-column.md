description: A query over a union returned wrong rows, with no error, when the union's first branch selected the same column twice. Fixed where a projection hands out its column identifiers, so one projection never gives two output columns the same identifier.
architecture: docs/optimizer.md#attribute-provenance
files: packages/quereus/src/planner/util/output-names.ts (uniqueOutputId), packages/quereus/src/planner/nodes/project-node.ts (attributesCache, candidateOutputId), packages/quereus/src/planner/nodes/returning-node.ts (buildAttributes, candidateOutputId), packages/quereus/src/planner/analysis/attribute-provenance.ts (computeAttributeProvenance), packages/quereus/src/planner/nodes/recursive-cte-node.ts (buildAttributes comment), packages/quereus/src/planner/building/with.ts (workingTableAttributes comment), packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic, packages/quereus/test/planner/attribute-provenance.spec.ts, docs/optimizer.md, docs/invariants.md
repro: verified
----
# A projection no longer publishes one column identifier at two output positions

## What was wrong

The planner names each output column by a numeric attribute id, and the runtime finds a column's value by mapping that id to a row slot (`buildRowDescriptor`: last position wins). `ProjectNode` forwarded the source id for every bare column reference, so `select id as x, id as y from A` published one id at positions 0 and 1. `SetOperationNode` publishes its left branch's ids, so a union whose left branch was that projection had `x` and `y` share an id, and any reader above the union that resolved `x` by id read `y` for the right branch's rows. Example: `select u.x from (select id as x, id as y from A union all select id as x, a_id as y from B) u` returned `1, 1` instead of `1, 2`.

## What changed

- `uniqueOutputId(published, id)` in `planner/util/output-names.ts` (next to `disambiguateColumnNames`, its name counterpart): returns `id` the first time a node publishes it and `PlanNode.nextAttrId()` for any repeat.
- `ProjectNode`: the three id sources (optimizer-supplied `attributeId`, forwarded column reference, `preserveInputColumns: false` minting) moved into `candidateOutputId`, and the builder now emits one attribute literal per projection through `uniqueOutputId`. Behaviour is unchanged except for repeats. The predefined-attributes path is still verbatim, and every rule that rebuilds a `ProjectNode` with `attributeId`s copies them from an existing `ProjectNode`, whose ids are now already distinct.
- `ReturningNode`: the same restructure and helper. The full validator run (below) showed `returning new.value, old.value` publishes one id twice, because both column references carry the same attribute id. The RETURNING emitter evaluates projections by position, so only readers above the node use those ids.
- `computeAttributeProvenance`: the "one node lists an id twice" check now runs before the forwarded-id skip, so a node forwarding one child id at two positions throws `Duplicate attribute ID … within the output of …`. The old `existing.originNode === node` branch was removed. It is unreachable now, because a node is visited once and the new check catches any repeat first.
- Comments: the recursive-CTE `NOTE:` tripwire (base case could repeat an id) is replaced by a plain comment saying why the ids are distinct. The `workingTableAttributes` doc in `with.ts` drops its now-false first reason and keeps the second. The function itself is unchanged, as the ticket asked.
- Docs: `docs/optimizer.md` § Attribute provenance and `docs/invariants.md` OPT-014 now describe first-position forwarding, fresh ids for repeats (both nodes), and the stricter provenance check.

## Tests added

- `28-set-ops-sort-edge-cases.sqllogic`, section "SET OPERATIONS: first branch selects one column twice": two queries, a join above the union and a plain projection above it. They failed before the fix (`{x:1,y:1}` where `{x:2,y:1}` was expected) and pass after.
- `attribute-provenance.spec.ts`, "throws when a single node forwards one child id at two positions": pins the stricter OPT-014 check (forwarded repeats used to be skipped).

## Validation

- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn workspace @quereus/quereus test`: 11157 passing, 26 pending, 0 failing.
- Ad-hoc script, not kept: every row of the original ticket's table (join, cross join, plain projection, `where u.x = 2`, `group by u.x`, `where u.y = 1`, `where u.y in (…)`, and the compound select with `order by y, x`) now returns the expected rows.
- Temporary `validate_plan`-on full run, now reverted. The value the optimizer reads is `debug.validatePlan` in `optimizer-tuning.ts`, not the option default in `database.ts`, so that is what was flipped. First run: 3 `Duplicate attribute ID` failures, all `Block > Returning` (`42-returning`, `42.1-returning-extras`, `42.2-returning-stored-row`), which the `ReturningNode` change fixed. After the fix: 0 duplicate failures, but 388 other validator failures. The same 388 messages appear with both of this ticket's changes disabled, so they predate this ticket. Filed as `debt-plan-validator-fails-across-suite` in backlog, with counts by category.

## Known gaps for the reviewer

- The validator sweep is incomplete. A sqllogic file stops at its first failure, and many files fail early with validate-on for the pre-existing reasons, so later statements in those files were never checked for duplicate ids. Other node families that repeat ids may remain. The ticket named aggregate builders in `select-aggregates.ts` that pass `colRef.attributeId`, and a join over one shared subtree on both sides. Neither surfaced, but that is not proof they are absent.
- A join whose two sides are the same subtree instance would now throw in the provenance walk, since it lists every id twice. No such plan surfaced in the run. Before this change it was already broken at runtime for the same slot reason, so the throw only surfaces an existing defect.
- An id-based reader of a repeated id used to resolve to the last position, and now resolves to the first, which keeps the source id. Within one node the two positions hold the same value. The exception is `returning new.v, old.v`, where the positions differ, but no reader above RETURNING resolves by id today: CTE references mint their own ids.
- `test:store` was not run (planner-only change).
