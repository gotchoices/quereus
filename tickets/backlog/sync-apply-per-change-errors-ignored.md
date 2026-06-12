description: change-applicator ignores ApplyToStoreResult.errors — CRDT metadata is committed for changes whose storage apply failed, so the failed data is never re-fetched
files:
  - packages/quereus-sync/src/sync/change-applicator.ts   # phase 2 discards the applyToStore return value; phase 3 commits metadata for ALL resolved changes
  - packages/quereus-sync/src/sync/protocol.ts            # ApplyToStoreResult.errors contract
  - packages/quereus-sync/src/sync/store-adapter.ts       # populates result.errors per change/table
----

# Sync apply: per-change storage errors silently commit their CRDT metadata

## Problem

`applyChanges` (change-applicator phase 2) calls `await ctx.applyToStore(...)`
and discards the returned `ApplyToStoreResult`. Only a **thrown** error aborts
the apply; per-change failures reported in `result.errors` (the adapter
records them per table/change — e.g. one table's store failed while others
applied) are invisible. Phase 3 then commits CRDT metadata for **all**
resolved changes, including the failed ones.

Consequence: the local column-version/HLC metadata claims those changes were
applied, so subsequent delta syncs never re-fetch them — the row data is
permanently missing on this replica (until some later change touches the same
columns).

## Expected behavior

Changes whose storage apply failed must not have their CRDT metadata
committed — they should remain eligible for re-resolution on the next sync
attempt, exactly like the whole-batch throw path. Either:

- change-applicator inspects `result.errors` and excludes the failed changes
  from `commitChangeMetadata` (per-change recovery), or
- the contract is simplified to all-or-nothing (adapter throws on any
  failure) and `ApplyToStoreResult.errors` is dropped.

The snapshot apply paths (`snapshot.ts`, `snapshot-stream.ts`) discard the
result the same way and need the same treatment.
