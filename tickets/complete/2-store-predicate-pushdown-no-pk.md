description: Store-module predicate pushdown no longer drops range filters on non-leading PK columns (notably tables without an explicit PRIMARY KEY).
files:
  packages/quereus-store/src/common/store-module.ts (getBestAccessPlan range branch)
  packages/quereus-store/test/pushdown.spec.ts (regression spec)
  packages/quereus/test/logic/pushdown-test.sqllogic (now passes under store mode)
----

## What was built

`StoreModule.getBestAccessPlan` (`packages/quereus-store/src/common/store-module.ts:797-821`) used to mark range filters as `handled=true` for *any* PK column. The legacy access-path planner (`packages/quereus/src/planner/rules/access/rule-select-access-path.ts:698-738`) only forwards range bounds for `primaryKeyDefinition[0]`, so any range on a later PK column was silently dropped. On a table with no explicit PK — where every column is part of the implicit PK — `WHERE age > 25` therefore returned every row.

The fix narrows the range branch to filters whose `columnIndex === primaryKeyDefinition[0].index`. Anything else falls through to the secondary-index check and ultimately the full-scan path with `handledFilters` all `false`, keeping the residual predicate above the scan where the engine applies it. The `firstPkColumn !== undefined` guard short-circuits the unusual empty-PK case so the planner stays conservative even on hypothetical PK-less schemas.

The pattern mirrors the already-conservative secondary-index branch in the same method, which deliberately reports `handled=false` because the runtime can't apply index-backed bounds yet.

## Key files
- `packages/quereus-store/src/common/store-module.ts:797-821` — narrowed range branch with comment explaining why.
- `packages/quereus-store/test/pushdown.spec.ts` — regression spec (range on PK / non-PK / no-PK leading / no-PK non-leading / compound).
- `packages/quereus/test/logic/pushdown-test.sqllogic` — now passes under `QUEREUS_TEST_STORE=true`.

## Validation

- `yarn workspace @quereus/store test` → 216 passing (includes new `pushdown.spec.ts`).
- `yarn workspace @quereus/quereus test` → 2443 passing, 2 pending.
- `yarn workspace @quereus/quereus lint` → 0 errors.
- `yarn workspace @quereus/store build` → clean.

The pre-existing `03.6-type-system.sqllogic:235` JSON round-trip failure under `yarn test:store` (noted in the implement ticket) is unrelated and tracked separately.

## Usage notes
- A "handled" range scan still falls back to `StoreTable.scanPKRange`, which today does a full scan plus `matchesFilters`. Real byte-range PK seek is a future optimization, called out in the original plan and explicitly out of scope here.
- The `getBestAccessPlan` equality branch is unchanged: it requires equality on every PK column and the legacy planner supports composite PK seeks, so multi-column PK equality remains a point lookup.
