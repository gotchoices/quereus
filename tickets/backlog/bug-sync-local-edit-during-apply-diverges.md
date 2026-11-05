description: If a device edits a row in the brief moment after an incoming sync change has written that row but before sync has filed its bookkeeping, the edit stays in that device's row while sync's records keep the old value, so the device silently disagrees with the others.
architecture: docs/sync-transactions.md
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # applyChanges drains the commit chain (~507), then commitChangeMetadata overwrites the local capture's cell records; setColumnVersionBatch (~1545)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # enqueueTransactionCommit (~861): local capture runs behind the engine commit, with no ordering against an apply's data write
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The window lasts only as long as one apply, and the reproduction had to force the timing, so it may never be seen in practice; closing it means ordering local capture against applies, which have a known deadlock risk around the commit chain.
----

## What happens

Reproduced in-process with real engines by running a local update from inside the receiver's `applyToStore`, so the timing is forced. It has not been seen under natural timing.

1. A sender inserts `(1, 'one', 1)`. The receiver's apply writes the row.
2. Before the apply files its metadata, the receiver runs `update orders set qty = 2 where id = 1`. Local capture records `qty = 2` under a local timestamp.
3. The apply files its metadata, overwriting that record with the sender's `qty = 1`.

| | Receiver |
|---|---|
| Row | `(1, 'one', 2)` |
| Cell record for `qty` | `1`, with the sender's timestamp |
| Next push of that cell | nothing |
| What another device reading this one receives for that cell | `qty = 1` |

The receiver's row says 2, and its metadata says 1, as does the sender. Only the receiver, its push list and what it serves were inspected; the change was not relayed onward, so a third device was not observed. Only a new row was tried. An edit of a row that already has records was not run.

Re-run after `bug-sync-late-push-skipped-by-newer-watermark` landed, which is where the push list above changed (it used to carry `qty = 1` under the sender's timestamp). The apply's final metadata write now runs on the same queue as local capture, but that does not close this: the apply decides what to write before the local edit happens. The capture's change-log entries are left behind when the apply overwrites its cells. Each then points at a record filed at another position, which the read side treats as stale and skips, so the local edit is sent to nobody; `repairChangeLog` removes them (three in the run, one per column, because the edit was the first sync had seen of the row). Since the local timestamp is gone, nothing later should correct the row.

## Expected behaviour

A local edit committed during an apply survives on every device or is lost on every device, by the usual last-writer-wins rule. The row and its cell records never disagree.
