description: Make the app actually replay held sync edits when a deleted table comes back, by calling the new drain routine from the periodic maintenance loop (today nothing calls it, so the edits still sit until they expire).
prereq:
files:
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager.drainHeldChanges (the API to call)
  - quoomb-web/                                                # web worker / maintenance path calling pruneTombstones etc.
  - packages/sync-coordinator/                                 # coordinator maintenance path (relay-only — drain is a no-op there)
difficulty: medium
----

# Wire `drainHeldChanges` into a host maintenance loop

## Context

`sync-held-change-drain-on-reappear` delivered the library primitive
`SyncManager.drainHeldChanges(schema?, table?)` — the host-driven sweep that replays
held out-of-basis changes into a table that has reappeared in the local basis (see
`docs/sync.md` § Unknown-Table Disposition → Revival / drain). By deliberate design
the library adds **no timer** and never drains inline; the host decides cadence.

**No production caller invokes it.** The hosts that already run periodic sync
maintenance — calling the sibling methods `pruneTombstones` / `pruneQuarantine` /
`evictExpiredBasisTables` — do **not** yet call `drainHeldChanges`. Until one does,
a reappeared table's held changes are never actually replayed in the real app; they
sit until horizon GC reclaims them — the exact latency the drain feature exists to
remove. The primitive is correct and tested, but dormant.

## What to do

- Find the host maintenance path(s) that already call the sibling prune/evict sweeps
  (quoomb-web worker / sync-coordinator — confirm which actually own a basis oracle;
  a relay-only coordinator has no `getTableSchema`, so drain is a documented no-op
  there and need not call it).
- Call `drainHeldChanges()` (no-arg sweep form) on the same cadence, OR scoped
  `drainHeldChanges(schema, table)` right after the host re-creates / applies an
  inbound `create_table` for a previously-retired table (lower latency than waiting
  for the next tick).
- Surface the `onHeldChangesDrained` event where the other sync telemetry is consumed.

## Notes

Out of scope for the library ticket by design (cadence is a host policy). This ticket
realizes the end-user value of the primitive. Decide sweep-vs-scoped (or both) per
host; document the cadence choice.
