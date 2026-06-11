description: StoreTable.update()'s internal reads (insert PK-conflict probe, update/delete oldRow reads, PK-change conflict probe) are committed-only and miss this transaction's pending ops — silent PK overwrite instead of UNIQUE error, leaked secondary-index entries, wrong stats deltas, and events missing oldRow for intra-transaction rows. Pre-existing; masked under the isolation wrapper; observable on the bare StoreModule.
files:
  - packages/quereus-store/src/common/store-table.ts   # update() arms; readLiveRowByPk (the existing pending-overlay read primitive)
  - packages/quereus-store/src/common/transaction.ts   # getPendingOpsForStore (read-side index, landed in store-backing-host-substrate)
----

# Bare-store DML internal reads ignore pending writes

`store-backing-host-substrate` gave the bare `StoreModule` read-your-own-writes
on the QUERY side (`query()`'s three arms merge the coordinator's pending ops).
The WRITE side — `StoreTable.update()`'s own internal reads — still reads the
committed store only, so DML decisions inside an open transaction disagree with
what queries see:

- **insert arm** — `existing = await store.get(key)`: a row inserted earlier in
  the SAME transaction is invisible to the PK-conflict probe. A second insert at
  the same PK silently last-write-wins overwrites the pending row instead of
  raising `UNIQUE constraint failed` (or routing IGNORE/REPLACE). The memory
  module raises the constraint.
- **update arm** — `oldRowData = await store.get(oldKey)`: for an
  intra-transaction row, `oldRow` is `null`, so `updateSecondaryIndexes` removes
  nothing — an UPDATE that changes an indexed column leaks the old index entry
  written earlier in the transaction; the update event carries `oldRow:
  undefined`.
- **update arm, PK-change** — `existingAtNew = await store.get(newKey)`: the
  in-code comment says "Read through the coordinator so an evictee written
  earlier in the same transaction is visible", but the code reads committed-only
  — the comment documents intended behavior that was never implemented. A
  PK-change onto a pending row silently overwrites it (no conflict, no REPLACE
  eviction bookkeeping).
- **delete arm** — `oldRowData = await store.get(key)`: deleting an
  intra-transaction row skips index cleanup and the `-1` stats delta, and the
  delete event lacks `oldRow`.

`readLiveRowByPk` (pending-delete ⇒ gone, pending-put ⇒ its value, else
committed `get`) is the existing primitive these probes should read through.

## Constraints / expectations

- The `trustedWrite` insert INTERNAL guard must STAY committed-only — the
  isolation flush relies on it reading the committed store (analyzed and pinned
  in `store-backing-host-substrate`; flush probes never see pending ops on their
  own key because the overlay holds at most one entry per PK).
- Under the isolation wrapper these gaps are masked (the overlay owns
  intra-transaction state; flush writes are `trustedWrite` with one entry per
  PK), which is why no current suite fails. The bare module — now with RYOW
  queries, and soon the substrate for the `using store` MV backing host — is
  where the divergence is observable.

## Use cases to pin

- `begin; insert (1,'a'); insert (1,'b')` → `UNIQUE constraint failed` (PK),
  matching the memory module; `insert or ignore` / `or replace` route correctly
  against the pending row.
- `begin; insert; update` changing an indexed column → exactly one index entry
  for the row after commit.
- `begin; insert; delete` → stats delta nets zero; no index entries remain.
- `begin; insert (2,…); update … set pk = 2 where pk = 1` → PK conflict (or
  REPLACE reporting the pending row as `replacedRow`).
- Update/delete events for intra-transaction rows carry the pending `oldRow`.
