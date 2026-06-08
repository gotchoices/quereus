description: SortCapable interface now preserves nulls ordering
files:
  packages/quereus/src/planner/nodes/sort.ts
  packages/quereus/src/planner/framework/characteristics.ts
  packages/quereus/test/optimizer/ordering-propagation.spec.ts
----
## What was built

The `SortCapable` interface and `SortNode` implementation now fully preserve the optional `nulls?: 'first' | 'last'` field through all operations:

- **`SortCapable` interface** (`characteristics.ts:153-156`) — Both `getSortKeys()` return type and `withSortKeys()` parameter type include `nulls?`.
- **`SortNode.getSortKeys()`** — Includes `nulls` in returned objects.
- **`SortNode.withSortKeys()`** — Preserves `nulls` from input keys and includes it in change-detection.
- **`SortNode.withChildren()`** — Already preserves `nulls` from existing sort keys.
- **`SortNode.getLogicalAttributes()`** and **`toString()`** — Both include `nulls` in output.

## Key design notes

- The `SortCapable` interface uses inline type literals rather than importing `SortKey` from `sort.ts` to avoid a circular dependency (sort.ts imports `SortCapable` from characteristics.ts).
- `extractOrderingFromSortKeys()` in `physical-utils.ts` only uses `expression` and `direction` — the extra `nulls` field is structurally compatible and doesn't need changes.
- No external callers of `withSortKeys()` exist yet; the interface is ready for future optimizer rules.

## Testing

- **Plan-level tests** added to `ordering-propagation.spec.ts`:
  - `NULLS ordering is preserved in sort plan node` — verifies NULLS LAST appears in plan detail and produces correct row ordering
  - `NULLS ordering round-trips through plan attributes` — verifies DESC NULLS FIRST is captured in the plan's logical properties JSON
- **Pre-existing end-to-end coverage** in sqllogic tests (03.6, 07, 07.5, 14-utilities) covers NULLS FIRST/LAST runtime behavior
- All 1015 tests pass, build clean

## Usage

```sql
SELECT * FROM t ORDER BY col ASC NULLS LAST;
SELECT * FROM t ORDER BY col DESC NULLS FIRST;
```
