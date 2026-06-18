description: Add an end-to-end test that proves held sync edits really replay into a re-created table through the actual storage engine, not just the in-memory test stub.
prereq:
files:
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts   # existing real-adapter e2e pattern to mirror
  - packages/quereus-sync/src/sync/change-applicator.ts                   # drainHeldChanges / drainTableGroup under test
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts     # current stub-store drain coverage (the floor)
difficulty: medium
----

# Harden the held-change drain (revival) path with a real-store integration test

## Context

`sync-held-change-drain-on-reappear` shipped `SyncManager.drainHeldChanges(schema?, table?)`:
held out-of-basis changes (`quarantine` + forwardable `store-and-forward`) for a
table that has reappeared in the local basis are replayed into it and cleared from
the hold. See `docs/sync.md` § Unknown-Table Disposition → Revival / drain.

The delivered tests (`drainHeldChanges (revival)` block in
`unknown-table-disposition.spec.ts`) drive resolution through the real CRDT metadata
stores but apply data into a **tiny in-memory `Map` stub**, not the real store
adapter (`createStoreAdapter`). So several claims are verified only at the
CRDT-metadata + stub-store level, never end-to-end through the engine seam.

## What an integration test should pin

Mirror `store-and-forward-relay-e2e.spec.ts` (real `Database` + `StoreModule` + store
adapter, queried back with `select`) for the drain path:

- A held change drains into a **re-created real table** and is queryable via `select`,
  carrying the straggler's **origin HLC**.
- **MV maintenance / `Database.watch`** fire on the revival (the stub cannot exercise
  these — `onRemoteChange` is emitted, but no real derived effects run).
- **Delete of an absent pk is a genuine store no-op** (the stub just skips a missing
  key; assert the real adapter does not throw `Table not found` or leave residue).
- **Forwardable → drain → relay-stops** lifecycle: after drain, the entry is gone from
  `listForwardable()` AND the value now rides the normal change log (`getChangesSince`
  relays it as a real local version, not as a forwardable hold).
- **Schema-drift drop** against a really-re-created-without-the-column table.

## Notes

Not a defect in the shipped code — the unit suite is a correct floor; this is
hardening that would catch adapter-seam regressions the stub cannot. Treat the
current `drainHeldChanges (revival)` block as the baseline to extend, not replace.
