description: Fixed CTENode.buildAttributes() to use positional mapping instead of name-based lookup for explicit CTE column names
prereq: none
files:
  packages/quereus/src/planner/nodes/cte-node.ts
  packages/quereus/test/logic/13-cte.sqllogic
----
## What was built

Fixed a bug where `CTENode.buildAttributes()` used name-based lookup to resolve column types when explicit CTE column names were provided (e.g., `WITH cte(x, y) AS (SELECT a, b FROM t)`). Since renamed columns don't match source names, all types fell back to `TEXT`. Switched to positional mapping, matching the existing `RecursiveCTENode.buildAttributes()` pattern.

Also cleaned up 4 `any` casts and removed unused `ScalarType`/`TEXT_TYPE` imports.

## Key files

- `packages/quereus/src/planner/nodes/cte-node.ts` — `buildAttributes()` now uses `queryAttributes.map((attr, index) => ...)` for positional column-to-type mapping
- `packages/quereus/src/planner/nodes/recursive-cte-node.ts` — sibling node already used positional pattern (consistency confirmed)

## Testing

- **New test** in `13-cte.sqllogic:130-134`: `WITH cte(x, y) AS (SELECT 1 AS a, 'hello' AS b) SELECT typeof(x), typeof(y) FROM cte` — verifies `integer`/`text` types propagate through renamed columns
- All 329 tests pass (1 pre-existing failure in `10.1-ddl-lifecycle.sqllogic` unrelated)
- Build and lint clean

## Usage

Explicit CTE column names now correctly inherit types from the source query by position:
```sql
WITH cte(x) AS (SELECT id FROM t) SELECT x FROM cte  -- x is INTEGER, not TEXT
```
