description: A device that deletes rows while offline and stays offline for more than a month quietly forgets those deletions before it ever gets to tell the server, so the rows come back from the server when it reconnects.
architecture: docs/sync.md
files:
  - packages/quoomb-web/src/worker/quereus.worker.ts          # startSyncMaintenance (~806): the browser replica runs the full maintenance pass, including pruneTombstones
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # pruneTombstones (~1620) prunes by age alone
  - packages/quereus-sync/src/sync/maintenance.ts             # runSyncMaintenancePass
  - packages/quereus-sync-client/src/sync-client.ts           # pushLocalChanges (~1059) reads since lastSentHLC; getPeerSentState is the durable sent watermark
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Needs a device offline for longer than the 30-day horizon with local deletes it never pushed; the fix couples the maintenance sweep to per-peer sent watermarks, which a replica syncing with several servers has to take the minimum of.
----

## What is wrong

The browser replica (quoomb-web's worker) runs the same hourly maintenance pass as the server, including `pruneTombstones`, which expires a tombstone purely by age (`retentionHorizonMs`, 30 days). A tombstone is also the only record that a local delete needs to be **pushed** to the server: `pushLocalChanges` collects changes since the sent watermark (`lastSentHLC`, persisted via `updatePeerSentState`), and a delete whose tombstone is gone has nothing to collect.

So a device that deletes rows while offline, then stays offline past the horizon, prunes its own unsent deletes. On reconnect it pushes nothing for them, and the next delta or snapshot from the server brings the rows back. The server-side mirror of this (serving a delta past pruned history) is handled by `bug-sync-delta-served-past-retention-horizon`, which introduces a per-replica "delta floor" raised by every prune; on a client that floor rising above the sent watermark is precisely this loss, and the client's `getChangesSince` will log a warning when it happens. The warning makes it visible; it does not prevent it.

Inferred from code: `pruneTombstones` consults no watermark; the worker wires the full pass. What would confirm it: a `SyncManagerImpl` with `retentionHorizonMs: -1`, one local delete, `pruneTombstones()`, then `getChangesSince(serverSiteId, watermarkBeforeDelete)` returns no delete.

## Expected behaviour

A replica must not prune a tombstone it has not yet pushed to every peer it pushes to. The natural rule: `pruneTombstones` keeps any tombstone whose HLC is above the **minimum sent watermark** across known peers (`pt:` records), regardless of age. A replica with no sent watermark (never pushed) keeps everything. The server (which pushes to no one) is unaffected because it has no `pt:` records.

Alternative worth comparing: the host decides. The library pass takes an optional "do not prune above" HLC that the sync client supplies from its sent watermark; the worker's maintenance ticker already has the sync manager and client in hand. Simpler in the library, but every host has to remember to pass it.

## Note from sync-client-pushes-back-server-changes

Once that ticket lands, a device's sent watermark moves only when it pushes its own writes, and a device that never writes has none. The "minimum sent watermark" rule above would then keep other devices' tombstones forever on such a device. Apply the rule to tombstones this device wrote, since those are the only ones it has to push. The client's push will also read through `getChangesToPush`, which has no delta-floor warning, so the warning mentioned above no longer fires on this path.
