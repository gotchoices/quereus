description: A recursive query whose start row selects the same column twice read the first output column as the second in the recursive step; it now keeps the two columns independent.
files: packages/quereus/src/planner/building/with.ts (buildRecursiveCTE, workingTableAttributes), packages/quereus/src/planner/nodes/recursive-cte-node.ts (buildAttributes NOTE), packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic
repro: verified
----
# Recursive CTE: repeated start-row column read as its twin — fixed

## What was wrong

`with recursive pd(proto_id, id) as (select id, id from E … union all select PD.proto_id, E.id from E join pd PD on E.parent = PD.id)` returned `proto_id` equal to the parent's id from depth two on.

A `ProjectNode` keeps the source attribute id for a bare column reference, so `select id, id` publishes one attribute id in both output positions. `RecursiveCTENode.buildAttributes` copies the base case's ids, and `buildRecursiveCTE` passed those to the `InternalRecursiveCTERefNode` (the working-table reference the recursive step reads). The runtime row descriptor maps an id to a single slot index, so `PD.proto_id` read column 1. Outer references were unaffected because `CTEReferenceNode` mints fresh ids per reference.

## The fix

`buildRecursiveCTE` builds the working-table reference with `workingTableAttributes(recursiveCTENode)`: one fresh attribute id per column, same name and type — the same approach as `CTEReferenceNode.buildAttributes` and `makeMultiSourceKeyRef`. `RecursiveCTENode`'s own attributes still reuse the base-case ids; every current reader binds them by position, so that is recorded as a `NOTE:` tripwire in `recursive-cte-node.ts` `buildAttributes`.

Test: `13.3-cte-edge-cases.sqllogic` "Recursive CTE: start row selects one column twice" (fails without the fix with `{"root":2,"id":4}`).

SiteCAD works around this with `col + 0`; that workaround can be dropped once this ships.

## Review findings

- **Diff read first** (`ticket(implement): recursive-cte-repeated-start-column-read-as-twin`). The fix is at the correct site: the only place the working-table ref is built for recursive CTEs. The other `InternalRecursiveCTERefNode` constructor (`makeMultiSourceKeyRef` in `mutation/multi-source.ts`) already mints fresh ids.
- **Downstream reliance on shared ids:** checked `emitInternalRecursiveCTERef` (builds its row descriptor from the ref's own attributes), `emitRecursiveCTE` (no attribute-id use), `buildFrom` in `select.ts` (wraps the ref in `AliasNode` and registers the column scope from it), and the materialization-advisory pass (keys on `tableDescriptor`, not attribute ids). None depended on the ref sharing ids with the base case. No issue.
- **Minor, fixed:** `workingTableAttributes` copied `sourceRelation`, which `InternalRecursiveCTERefNode.buildAttributes` overwrites with `recursive_ref:<name>` anyway; removed the dead field.
- **Edge cases probed by hand (temporary logic file, deleted afterwards):** three copies of one column with the step rotating them (`select w.c + 10, ct.id, w.a`): correct. The working table referenced twice in the recursive step (`join w x … join w y`): runs and returns the expected rows. Both references share one ref instance and therefore one id set, but that was already true before this change, so it is not a regression. Not filed: SQLite rejects that non-linear recursion form, and the shared ids are harmless here because both aliases read the same row.
- **Tripwire:** the implementer's `NOTE:` on `RecursiveCTENode.buildAttributes` (base-case ids repeat; mint fresh ids if anything starts resolving them by id) is accurate; left as is.
- **Tests:** the one added test reproduces the defect being fixed and stays. Nothing to cut.
- **Docs:** `docs/sql-select.md`, `docs/optimizer.md` and `docs/runtime-caching.md` describe recursive CTE semantics and buffering, not attribute-id binding. Nothing in them changes, so no doc update.
- **Validation:** `yarn workspace @quereus/quereus lint` is clean. `yarn workspace @quereus/quereus test`: 11123 passing, 26 pending, 0 failing. `yarn test:store` was not run because the change is planner-only.
- **Major findings / tickets filed:** none.
