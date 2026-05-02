description: Cross-layer UNIQUE/PK conflict detection in IsolatedTable (resolve-at-write)
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
  docs/design-isolation-layer.md
----

## What was built

`IsolatedTable.update()` now detects UNIQUE and PRIMARY KEY conflicts that span the overlay+underlying boundary at write time, instead of silently overwriting at flush. Resolution uses Option B (resolve-at-write) so `flushOverlayToUnderlying` remains a dumb apply.

New helpers in `packages/quereus-isolation/src/isolated-table.ts`:

- `keysEqual(a, b)` — element-wise PK equality via `compareSqlValues`.
- `getUnderlyingRow(pk)` — O(log n) point-lookup against the underlying table using `buildPKPointLookupFilter`.
- `insertTombstoneForPK(overlay, pk, tombstoneIndex)` — writes a PK-only, null-filled tombstone (or updates an existing overlay row to a tombstone) so the corresponding underlying row is hidden after flush.
- `checkMergedPKConflict(overlay, newPK, tombstoneIndex, onConflict)` — when the overlay has no entry at newPK, checks the underlying. Returns null for ABORT-not-conflicting / REPLACE-same-PK; returns `{status:'ok'}` for IGNORE; returns a `unique` constraint result for ABORT-conflict.
- `findMergedUniqueConflict(overlay, cols, newRow, selfPks, tombstoneIndex)` — full-scan of the underlying for a row matching the constrained columns, skipping selfPks and any PK currently tombstoned in the overlay.
- `checkMergedUniqueConstraints(overlay, newRow, selfPks, tombstoneIndex, onConflict)` — iterates non-PK UNIQUE constraints; ABORT returns the constraint result, IGNORE no-ops, REPLACE writes a tombstone for the conflicting underlying PK and continues.

INSERT path (`existingRow === undefined`) calls `checkMergedPKConflict` then `checkMergedUniqueConstraints` before delegating to `overlay.update`. The pre-existing tombstone-conversion branch (`existingRow[tombstoneIndex] === 1`) still runs first, so cross-layer checks never fire for an already-tombstoned overlay PK.

UPDATE `else` branch (target only in underlying) gained the same conflict checks plus an `insertTombstoneForPK(targetPK)` call when the PK changes — this also closes the pre-existing PK-change tombstone omission.

## Test harness changes

- `47-upsert.sqllogic` and `102-unique-constraints.sqllogic` removed from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`; both now pass in store mode.
- `04-transactions.sqllogic` remains excluded with an updated comment: savepoint rollback does not undo writes when the overlay was created after the savepoint (separate issue).

## Tests added

`packages/quereus-store/test/isolated-store.spec.ts` gains a `cross-layer UNIQUE / PK conflict detection` describe block:

- INSERT colliding with underlying PK → constraint error
- INSERT OR IGNORE on PK collision with underlying → silent no-op
- INSERT OR REPLACE on PK collision with underlying → row replaced
- INSERT colliding with non-PK UNIQUE in underlying → constraint error
- INSERT OR IGNORE on non-PK UNIQUE collision → silent no-op
- INSERT OR REPLACE on non-PK UNIQUE collision → underlying row evicted (tombstone), new row inserted
- UPDATE changing UNIQUE column to a value already in the underlying → constraint error
- Composite UNIQUE: conflicting/non-conflicting (a,b) tuples
- ON CONFLICT DO NOTHING on PK in underlying → skipped
- ON CONFLICT DO UPDATE on PK in underlying → row updated

## Test results

- `yarn test` — 2443 passing, 2 pending, 0 failing.
- `yarn test:store` — 2436 passing, 9 pending, 0 failing. The `50-declarative-schema.sqllogic` failure noted in the implement-stage handoff is no longer reproducing (resolved by an adjacent fix).

## Docs

`docs/design-isolation-layer.md` gained a `Cross-Layer Constraint Detection` section under `Key Ordering`, documenting the resolve-at-write strategy, PK and non-PK UNIQUE conflict paths, tombstone-for-evicted-row encoding, and current trade-offs (O(n) UNIQUE scan and absence of replacedRow propagation for same-PK REPLACE).

## Known limitations carried forward

- Non-PK UNIQUE checks do an O(n) underlying scan per write; index-based lookup is a future optimisation.
- Same-PK REPLACE through the isolation layer does not surface a `replacedRow` to the DML executor, so FK CASCADE side-effects do not fire for replacements resolved through the isolation layer.
