description: Skip parent-side FK NOT-EXISTS check when no referenced column changed
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## What landed

After `19e1963e` flipped FK ON UPDATE/ON DELETE defaults to `'restrict'`, every parent table received a synthesised NOT-EXISTS parent-side CHECK that fired on **every** parent UPDATE — breaking unrelated UPDATEs that don't touch any referenced parent column. The pre-existing "fix later" comment at `foreign-key-builder.ts:291-292` is closed.

### Code changes

- `packages/quereus/src/planner/nodes/constraint-check-node.ts` — added optional `referencedColumnIndices?: ReadonlyArray<number>` to the `ConstraintCheck` interface, populated only for parent-side FK checks.
- `packages/quereus/src/planner/building/foreign-key-builder.ts` — `buildParentSideFKChecks` carries the resolved `parentColIndices` onto the synthesised constraint via that field.
- `packages/quereus/src/runtime/emit/constraint-check.ts` — propagates the field into `ConstraintMetadataEntry`. In `checkCheckConstraints`, before running the evaluator, when `plan.operation === RowOpFlag.UPDATE && metadata.kind === 'fk-parent' && metadata.referencedColumnIndices`, OLD vs NEW are compared via `sqlValuesEqual` for each referenced column index; if none changed, the check is `continue`d past (skip lands ahead of the deferred-queue branch).

The OLD section of the flat row spans `0..n-1`, NEW spans `n..2n-1` (same shape consumed by the NOT NULL pass and `runUpdate`'s `changedColumns` computation).

## Why it's correct

- Child-side checks unaffected: only DELETE and UPDATE-on-the-parent need column-aware filtering.
- Cascading actions (`'cascade'`, `'set null'`, `'set default'`) never reach this code — `buildParentSideFKChecks` short-circuits at line 286 (`if (action !== 'restrict') continue;`).
- For RESTRICT (the only kind synthesised here) `shouldDefer` is false. The runtime skip lands ahead of the deferred-queue branch, so even a future caller routing `'fk-parent'` through deferred would not queue rows for unchanged columns.
- Filter is at runtime rather than plan time because the constraint-check node already receives the flat OLD+NEW row; doing this at plan time would multiply synthesised constraints per touched-column subset.

## Tests

`packages/quereus/test/logic/41-foreign-keys.sqllogic` — added a "Parent-side FK UPDATE column-mask" phase covering:

1. Parent UPDATE on a non-FK column with a referencing child row → succeeds (the regression case).
2. Parent UPDATE that touches the FK-referenced PK with a referencing child row → still trips RESTRICT.
3. Two FKs referencing different parent columns: updating only `label` fires only `pmask2_child_label`'s parent-side check; updating only `code` fires only `pmask2_child_code`'s; updating neither (just `extra`) skips both.

Note: in this engine a nullable column requires explicit `NULL` (`extra TEXT NULL`, not bare `extra TEXT`).

## Validation

- `yarn workspace @quereus/quereus run build` → exit 0.
- `yarn workspace @quereus/quereus run test` → 2643 passing, 2 pending, 0 failing.
- `yarn test:store` not run — runtime change is module-agnostic; the constraint-check path is shared by all storage modules.
