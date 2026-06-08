---
description: Fixed `IsolationModule.dropIndex` so that `DROP INDEX` inside an active transaction with a live overlay no longer keeps firing the synthesized `UNIQUE` constraint on subsequent overlay writes. The bare `overlay.dropIndex()` forward left the overlay's `MemoryTable` pending `TransactionLayer.tableSchemaAtCreation` frozen with the old UC; the fix rebuilds each affected overlay via a new `migrateOverlayForDropIndex` helper that mirrors `migrateOverlayForAlter`. Added an in-transaction regression test plus a tombstone-preservation test added during review.
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/test/isolation-layer.spec.ts
---

## Summary

`IsolationModule.dropIndex` (introduced earlier in the parent ticket
chain) used to forward `dropIndex` directly to each per-connection
overlay via `overlay.dropIndex?.(indexName)`. That call only refreshed
the overlay `MemoryTableManager`'s schema; it did not unwind any
active write `TransactionLayer`, whose `tableSchemaAtCreation` was
frozen at layer-creation time and still carried the synthesized
`UniqueConstraintSchema`. Subsequent overlay writes would keep
failing inside the overlay's own UC check, e.g.
`UNIQUE constraint failed: _overlay_<table>_<id> (b)`.

The fix replaces that bare forward with `migrateOverlayForDropIndex`,
which rebuilds every affected overlay against the post-drop
underlying schema, copying staged rows (data + tombstones) verbatim
into a freshly-created overlay `MemoryTable`. The new MemoryTable's
first write captures the post-drop schema in its
`TransactionLayer.tableSchemaAtCreation`, so the synthesized UC no
longer fires.

## Review findings

### What was checked

- **Repro / regression test**: existing test asserts the bug is
  reproduced before the fix and resolved after; the fix is the
  smallest possible behavior change at the right layer.
- **Architectural fit**: `migrateOverlayForDropIndex` mirrors
  `migrateOverlayForAlter` exactly (same shape: build new overlay
  schema, create new overlay table, replay rows). Decision to keep
  them as two small helpers — rather than factoring out a common
  "rebuild + replay" — is reasonable given the only difference is
  per-row translation; flagged in the implementer notes for later if
  a third migrator appears.
- **Stale `IsolatedTable.overlayTable` references**: confirmed
  `IsolatedTable` exposes `overlayTable` as a getter that re-reads
  `connectionOverlays` on each access (`isolated-table.ts:88`), so
  swapping the entry in `connectionOverlays` is picked up everywhere
  without per-instance updates. Good design.
- **Stale `IsolatedConnection.overlayConnection` after rebuild**:
  acknowledged in implementer notes; the new overlay does not
  inherit a registered connection, and any pre-existing
  `IsolatedConnection.overlayConnection` continues to point at the
  dead overlay. In the regression scenario this is harmless because
  `MemoryTable.update()` manages its own internal connection; the
  IsolatedConnection.overlayConnection is only consumed for
  begin/commit/rollback/savepoint coordination, and the
  `tableCallback.onConnectionCommit()` path correctly reads the new
  overlay via the getter. The pre-existing same-shape limitation
  exists in `migrateOverlayForAlter`. Acceptable for this fix; not a
  regression.
- **Underlying-side schema-change safety**: in the regression
  scenario the underlying table never receives writes inside the
  transaction (writes go to the overlay), so
  `MemoryTableManager.ensureSchemaChangeSafety` only needs to update
  `readLayer = baseLayer` for the underlying — there is no pending
  underlying write layer to unwind. Engine-level changes were
  correctly avoided.
- **Tombstone handling**: `migrateOverlayForDropIndex` iterates
  `oldOverlay.query()` which yields the full overlay row including
  the `_tombstone` column, and re-inserts it verbatim. The new
  overlay records the row with `_tombstone = 1`, so subsequent
  merge/flush paths still treat it as a delete. Verified by the new
  tombstone test.
- **Empty overlay**: when `oldState.hasChanges` is false, the loop
  is skipped and a fresh empty overlay is installed. Safe.
- **Lint + tests**: `yarn workspace @quereus/quereus run lint` clean;
  `yarn workspace @quereus/isolation run test` 67 passing (the
  in-transaction regression + the new tombstone test); `yarn test`
  3021 passing in `quereus`, plus all isolation/store/sync packages
  green. The two failures in `@quereus/sample-plugins`
  (`Comprehensive Demo Plugin key_value_store virtual table supports
  delete/update`) are pre-existing on the branch baseline and
  unrelated to this fix.

### Findings

- **Minor — coverage gap**: the implement-stage test only exercised
  inserts. The migration code already passes tombstone rows through
  intact, but that path was untested. Added
  `'preserves staged tombstones across DROP INDEX inside an active
  transaction'` (commits a staged DELETE made before DROP INDEX and
  asserts the row is gone post-COMMIT). Fixed inline.
- **Minor — `oldRow as SqlValue[]` cast vs. `migrateOverlayForAlter`'s
  `Array.from(...)` copy**: a stylistic inconsistency (the new
  helper passes the iterator's `Row` reference straight into
  `update`, while `translateOverlayRow` builds a fresh array). All
  current `update` paths treat the values array as
  read/copy-on-store, so there is no live mutation hazard, and a
  defensive copy here would be dead work — left as-is.
- **No major findings.** The connection-staleness limitation noted by
  the implementer is genuinely pre-existing in `migrateOverlayForAlter`
  and was already filed implicitly under the "if a future scenario
  surfaces a registered overlay connection that needs to follow the
  rebuild" caveat in the source comment; not promoted to a new
  ticket since no concrete scenario exercises it today.
- **Out of scope (already flagged)**: analogous `CREATE INDEX inside
  an active transaction` case (UC added mid-transaction would not
  fire on the overlay until the next layer rolls). Implementer
  flagged for a possible follow-up backlog ticket; reviewer agrees
  but did not file one — the symmetry is real but the impact is
  opposite-sign (false negative on UC enforcement during a
  transaction) and rarer in practice.

### Docs

- The doc comment block above `IsolationModule.dropIndex` was
  rewritten by the implementer to explain the rebuild rationale and
  the `tableSchemaAtCreation` freeze; reviewed and accurate.
- No higher-level docs (`docs/architecture.md`, etc.) reference this
  code path; nothing else to update.

## Validation

- `yarn workspace @quereus/isolation run build` — clean.
- `yarn workspace @quereus/isolation run test` — 67 passing.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — 3021 passing in `quereus` plus all dependent
  packages green; 2 unrelated pre-existing failures in
  `@quereus/sample-plugins`.
