description: A recursive query whose start row selects the same column twice read the first output column as the second in the recursive step; it now keeps the two columns independent.
files: packages/quereus/src/planner/building/with.ts (buildRecursiveCTE, new workingTableAttributes), packages/quereus/src/planner/nodes/recursive-cte-node.ts (buildAttributes comment), packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic
repro: verified
----
# Recursive CTE: repeated start-row column read as its twin — fixed

## What was wrong

`with recursive pd(proto_id, id) as (select id, id from E … union all select PD.proto_id, E.id from E join pd PD on E.parent = PD.id)` returned `proto_id` equal to the parent's id from depth two on.

Cause: a `ProjectNode` keeps the source attribute id for a bare column reference, so `select id, id` publishes the same attribute id in both output positions. `RecursiveCTENode.buildAttributes` copies the base case's ids, and `buildRecursiveCTE` passed those attributes straight to the `InternalRecursiveCTERefNode` (the working-table reference the recursive step reads). Both `PD` columns therefore carried one id; the runtime row descriptor maps an id to a single slot index (the last one), so `PD.proto_id` read column 1 (`id`). Outer references were never affected because `CTEReferenceNode` already mints fresh ids per reference.

## The fix

`buildRecursiveCTE` now builds the working-table reference with `workingTableAttributes(recursiveCTENode)`: one fresh attribute id per column, same name/type, so each column binds to its own position. This matches what `CTEReferenceNode.buildAttributes` and `makeMultiSourceKeyRef` already do for the same kind of reference. A side benefit: the recursive step's column reads can no longer resolve to a (closed) slot of the base case's own table scan, which previously shared the id.

`RecursiveCTENode`'s own attributes still reuse the base case ids (and can therefore repeat one). Every current reader binds them positionally, so this is left as a `NOTE:` tripwire in `recursive-cte-node.ts` `buildAttributes` rather than changed.

## Test added

- `test/logic/13.3-cte-edge-cases.sqllogic` — "Recursive CTE: start row selects one column twice": walks `ct` from id 1 with `select id, id` as the start row and asserts `root = 1` for every row including id 4 at depth two. Confirmed it fails without the fix (`{"root":2,"id":4}`) and passes with it.

## Validation

- `yarn workspace @quereus/quereus test`: 11123 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean.
- Hand-checked (not added as tests) against the fixed build, all correct: the ticket's original query; `select id as proto_id, id`; `union` (distinct) instead of `union all`; a recursive CTE referenced twice (shared-buffer path); columns declared in swapped order; three copies of the same column with one modified in the step; a correlated scalar subquery over the recursive CTE; non-recursive CTEs (materialized and `not materialized`) selecting a column twice.
- Not run: `yarn test:store` — the change is planner-only (attribute ids at plan build time), no store path involved.

## For the reviewer

- Check whether anything downstream relied on the working-table ref sharing ids with the `RecursiveCTENode` / base case (I found none: the ref's only consumers are the recursive step's column references, which resolve by name through the scope to the ref's own attributes).
- SiteCAD routes around this with `col + 0`; that workaround can be dropped once this ships.
