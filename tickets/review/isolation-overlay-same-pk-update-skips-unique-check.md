description: Inside a transaction on an isolated (store-backed) table, changing a UNIQUE column on a row written earlier in the same transaction now gets checked against already-committed rows, and the primary key's own conflict action no longer leaks onto other UNIQUE columns. Review the fix and its tests.
architecture: docs/design-isolation-layer.md#cross-layer-constraint-detection
files:
  - packages/quereus-isolation/src/isolated-table.ts                 # update(), 'update' case, same-PK arm under `existingOverlayRow` (~L1315); new private uniqueColumnsChanged next to compileFor (~L1530)
  - packages/quereus/src/schema/unique-enforcement.ts                # new shared uniqueColumnsChanged + anyColumnChanged
  - packages/quereus/src/index.ts                                    # re-export (~L227)
  - packages/quereus-store/src/common/store-table-constraints.ts     # uniqueColumnsChanged (~L226) now delegates
  - packages/quereus/src/vtab/memory/layer/manager.ts                # uniqueColumnsChanged (~L1229) now delegates
  - packages/quereus-isolation/test/isolation-layer.spec.ts          # describe 'same-PK UPDATE of a row staged in the same txn runs the merged UNIQUE check' (~L710)
  - packages/quereus/test/logic/47.2.1-pk-replace-secondary-unique.sqllogic   # sections P–S
  - docs/design-isolation-layer.md                                   # § Cross-Layer Constraint Detection
----

# Review: isolation overlay same-PK UPDATE now runs the merged UNIQUE check

## What changed

**Bug.** `IsolatedTable.update` stages writes in a private in-memory overlay table and flushes them at commit with `trustedWrite` (the underlying skips its UNIQUE re-check). The arm for an UPDATE whose target row is already live in the overlay and whose primary key is unchanged wrote the overlay directly. It never ran `checkMergedUniqueConstraints`, which searches overlay rows and committed rows. It also handed the overlay `argsForOverlay.onConflict`, which is the statement OR with the PK's `on conflict` default folded in, so the overlay's memory module applied the PK's action to every secondary UNIQUE. Depending on the backend and the declared actions, the result was a duplicate stored, an internal error at commit, a row silently deleted, or a row silently dropped.

**Fix (isolated-table.ts, same-PK arm).** When `uniqueColumnsChanged(existingOverlayRow.slice(0, tombstoneIndex), coercedValues)` is true, the arm runs `checkMergedUniqueConstraints(overlay, coercedValues, [targetPK], tombstoneIndex, args.onConflict, evicted)` with the statement's own OR, not the PK-folded one. A non-null result is returned. The overlay write still uses `argsForOverlay`: it can't conflict on the PK, and the merged check has already cleared or REPLACE-tombstoned every live UNIQUE conflict. The overlay's UNIQUE constraints are narrowed to live rows (`tombstone = 0`, see `createOverlaySchema`), so a tombstoned evictee can't trigger them. The arm now returns through `attachEvicted` like the other arms, so REPLACE evictions reach the DML executor's delete pipeline (FK cascade, change events).

**Gate shared, not copied.** `uniqueColumnsChanged(uniqueConstraints, oldRow, newRow, predicateColumns)` now lives in `schema/unique-enforcement.ts` and is exported from `@quereus/quereus`. Memory, store and isolation each wrap it and pass their own way of finding a partial predicate's referenced columns: memory uses the covering index's predicate or compiles one ad hoc; store and isolation use `compileFor`. Memory's NOTE about byte-level over-triggering on semantic-ordering columns moved onto the shared function. Memory and store behaviour is unchanged.

`update()` was not restructured into a single "merged checks, then overlay write" funnel. The minimal arm fix was cleaner. The class-level guard is still `debt-isolation-write-arm-differential-test` (backlog).

## Tests

- `isolation-layer.spec.ts`, new describe (8 tests): the ABORT-vs-committed collision raises CONSTRAINT and the commit stays consistent; PK `on conflict replace` plus a plain UNIQUE between two overlay rows raises, nothing deleted; UNIQUE `on conflict ignore` vs a committed row keeps `(1,'a')`; UNIQUE `on conflict replace` vs a committed row evicts it and the FK `on delete cascade` child disappears; `evictedRows` via a direct `IsolatedTable.update` for a committed evictee and for an overlay-resident evictee (reported once, not twice); a non-UNIQUE-column update and a same-value UNIQUE rewrite still succeed; a partial UNIQUE where only the predicate column changes, moving the row into scope onto a committed duplicate, raises.
- **Mutation check:** with the new gate forced false, 6 of the 8 fail. The two that pass are the gate-negative control and the overlay-resident REPLACE case, which the overlay's own memory module already handled; that test checks that no eviction is reported twice. Store-mode sqllogic also fails at section P without the fix.
- `47.2.1-pk-replace-secondary-unique.sqllogic` sections P–S: ABORT, PK-REPLACE leak, IGNORE, REPLACE with FK cascade child, all inside `begin … commit`. They pass in memory mode and in store mode (`QUEREUS_TEST_STORE`, through the isolation layer).

Runs (all green): `yarn workspace @quereus/isolation test` (436), `yarn workspace @quereus/store test` (1958), `yarn workspace @quereus/quereus test` (10765, 25 pending), store-mode logic tests `node test-runner.mjs --store --grep "SQL Logic Tests"` (366, 8 pending), `yarn workspace @quereus/quereus lint`, and `typecheck` for isolation and store.

## Known gaps / things to look at

- **Gate on a tombstoned target row.** If `existingOverlayRow` is a tombstone, the gate compares the deleted row's values with the new ones. A direct API `update` aimed at a PK deleted earlier in the transaction, rewriting it to the same UNIQUE value, skips the merged check and the overlay write revives the row. SQL can't reach this, because the executor's scan hides tombstoned rows. Before this fix there was no check at all on this arm. Reviving a row by UPDATE is a separate oddity (memory returns "not found" instead). Left alone; if you think it matters, the guard is `existingOverlayRow[tombstoneIndex] === 1 || uniqueColumnsChanged(...)`.
- **Over-triggering on semantic-ordering columns.** The gate compares bytes, so rewriting a TIMESPAN `'PT1H'` to `'PT60M'` re-runs the merged check, which costs a full overlay scan per UNIQUE constraint. This is correct and matches memory and store. It's documented in the NOTE on the shared helper.
- No mutation check was run for the memory/store refactor beyond the existing suites. It's a straight delegation with the same per-column `compareSqlValues` logic.
