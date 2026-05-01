description: IsolatedTable does not detect UNIQUE / PK conflicts across overlay+underlying, and flushOverlayToUnderlying drops the onConflict resolution
prereq: none
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/04-transactions.sqllogic
  packages/quereus/test/logic/47-upsert.sqllogic
  packages/quereus/test/logic/102-unique-constraints.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause

Two related gaps:

1. **Overlay-only UNIQUE check on insert/update.** `IsolatedTable.update` (`packages/quereus-isolation/src/isolated-table.ts:580-720`) routes inserts/updates straight into the overlay `MemoryTable`. The overlay only sees its own rows, so a duplicate PK or UNIQUE-column value that lives only in the underlying table slips through silently — the overlay accepts the row, then `flushOverlayToUnderlying` blows up at COMMIT time (or worse, REPLACE flow silently drops one side).

2. **`onConflict` is not forwarded by `flushOverlayToUnderlying`.** `flushOverlayToUnderlying` (`packages/quereus-isolation/src/isolated-table.ts:834-892`) calls `underlyingTable.update({operation:'insert', values, preCoerced:true})` without forwarding `onConflict`. So `INSERT OR REPLACE` / `INSERT OR IGNORE` semantics are lost when the row passes through the overlay path.

Underlying-table UNIQUE enforcement was already addressed by `complete/2-store-unique-constraint-not-enforced`. This ticket finishes the story at the isolation layer.

## Affected sqllogic

- `04-transactions.sqllogic` — duplicate PK during a multi-row INSERT batch in an implicit transaction; rollback semantics depend on detecting the conflict before flush.
- `47-upsert.sqllogic` — `INSERT … ON CONFLICT DO NOTHING / DO UPDATE / REPLACE` against rows that exist only in the underlying.
- `102-unique-constraints.sqllogic` — `INSERT OR REPLACE` evicting a conflicting underlying row; relies on `onConflict` flowing through to `underlyingTable.update`.

## Fix approach

- During `IsolatedTable.update` for `insert`:
  - Before delegating to `overlay.update(insert)`, point-look up the new PK in the underlying. If present and *not tombstoned* in the overlay, raise the same UNIQUE/PK conflict the overlay would (respecting `args.onConflict` for IGNORE/REPLACE).
  - For non-PK UNIQUE columns, run a `findUniqueConflict`-style scan over the merged view (overlay + underlying minus tombstones). The store layer already has a similar helper (`packages/quereus-store/src/common/store-table.ts:checkUniqueConstraints`) — model the isolation-layer version on it but read through the merged stream.
- During `IsolatedTable.update` for `update` that changes the PK (or any UNIQUE-covered column), run the same merged-view conflict check.
- In `flushOverlayToUnderlying`, forward `onConflict` from the original write down into `underlyingTable.update`. Since the overlay does not record per-row onConflict at flush time today, either:
  - **Option a:** carry the conflict policy on the overlay row (extra column or sidecar map keyed by PK), or
  - **Option b:** resolve UNIQUE/PK conflicts at write-time (above) so flush only ever has clean inserts/updates/deletes that cannot conflict. Option b is preferred — keeps flush a dumb apply.
- Re-enable the three sqllogic files in `MEMORY_ONLY_FILES` once green under `yarn test:store`.

## Validation

- New unit tests in `packages/quereus-store/test/isolated-store.spec.ts`:
  - INSERT a row with PK that collides with an underlying row → throws constraint error inside the transaction (not at COMMIT).
  - `INSERT OR IGNORE` on the same → silent no-op, underlying unchanged after COMMIT.
  - `INSERT OR REPLACE` on the same → underlying row is replaced after COMMIT.
  - UPDATE that retargets PK to an existing underlying PK → throws constraint error.
  - Composite UNIQUE on (a,b): underlying has (1,'x'); INSERT (1,'x') in transaction → conflict; INSERT (1,'y') → fine.
- `yarn test:store -- --grep "04-transactions|47-upsert|102-unique-constraints"` → all three files passing.
- `yarn test` (memory mode) — no regressions.

## TODO

- Add merged-view UNIQUE/PK conflict detection in `IsolatedTable.update` for `insert` and PK-changing `update`.
- Honour `args.onConflict` (REPLACE evicts; IGNORE silently skips) before delegating to overlay.
- Resolve conflicts at write-time so `flushOverlayToUnderlying` no longer needs `onConflict`.
- Add unit tests covering the five cases above.
- Remove `04-transactions.sqllogic`, `47-upsert.sqllogic`, `102-unique-constraints.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
