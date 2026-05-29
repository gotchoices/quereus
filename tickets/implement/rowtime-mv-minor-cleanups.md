description: Minor type-safety / DRY cleanups around row-time materialized-view maintenance, plus a note on a pre-existing predicate-truthiness divergence. None are correctness bugs in the shipped row-time feature; grouped here to avoid churning the green build at review time.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts
----

## Type-safety / DRY (minor)

- **`change` payload should be a discriminated union.** The maintenance change
  object `{ op: 'insert' | 'update' | 'delete'; oldRow?: Row; newRow?: Row }` is
  written verbatim in `dml-executor.ts` (`maintainRowTimeStructures`),
  `database.ts` (`_maintainRowTimeCoveringStructures`), and
  `database-materialized-views.ts` (`maintainRowTime` / `applyRowTimeChange`). In
  `applyRowTimeChange` it forces non-null assertions (`change.newRow!`,
  `change.oldRow!`) whose safety is by-convention, not by-type. Replace with a named
  exported discriminated union
  (`{op:'insert'; newRow:Row} | {op:'delete'; oldRow:Row} | {op:'update'; oldRow:Row; newRow:Row}`)
  so the asserts disappear and a future mis-paired hook site fails at compile time.
- **Duplicated table-key string.** `` `${tableSchema.schemaName}.${tableSchema.name}` ``
  is rebuilt inline at several hook sites in `dml-executor.ts`; hoist to the local
  `tableKey` already computed at some sites.
- **Cosmetic casts.** `project`'s `... as Row` (`applyRowTimeChange`) is structurally
  redundant (`SqlValue[]` is `Row`); the `this.ctx as unknown as Database`
  double-cast recurs (pre-existing file pattern — would be removed by exposing
  `getConnectionsForTable`/`registerConnection` on `MaterializedViewManagerContext`).
- **Implicit window-function rejection.** `buildRowTimePlan` has no explicit
  `PlanNodeType.Window` reject; window functions are caught structurally by the
  passthrough-projection check. Correct, but an explicit reject with a clear
  diagnostic would be more robust/self-documenting.

## Performance (minor, fine for v1)

- `getBackingConnection` scans all active connections for the table on every
  maintained row (O(active connections) per row). A per-transaction cache on the
  plan would help but risks staleness across txn boundaries — left out deliberately.

## Pre-existing predicate-truthiness divergence (note, not introduced here)

`compilePredicate` (`vtab/memory/utils/predicate.ts`) evaluates truthiness as
"non-(`false`|`0`|`0n`|`''`) ⇒ true", which **diverges** from the engine's canonical
`isTruthy` (`util/comparison.ts`) used by the real Filter/runtime path. `isTruthy`
does numeric-string coercion (`'abc' → 0 → false`, `'0' → false`, blobs → false,
`NaN → false`). So a partial MV with a *bare-column / string / blob / NaN* predicate
(e.g. `where flagcol` where `flagcol` is text) could include a row under row-time
maintenance that the same SELECT body would exclude — the materialized contents
disagree with the body. This is **shared, pre-existing** behavior (partial UNIQUE and
partial indexes use the same `compilePredicate`); row-time merely inherits it, and it
only bites bare-value predicates, not the comparison predicates (`x > 5`,
`status = 'active'`) that dominate real usage. Consider making `compilePredicate`
delegate truthiness to `isTruthy` so partial-index/unique/MV semantics all match the
query engine. Affects more than row-time, so scope/own it accordingly.
