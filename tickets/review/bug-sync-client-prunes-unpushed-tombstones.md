description: A device that deleted rows while offline for more than a month used to forget those deletions before telling the server, so the rows came back when it reconnected. Expiry now keeps any deletion the device has not yet delivered; this needs a review pass.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # pruneTombstones and the isUndeliveredOwnDelete predicate
  - packages/quereus-sync/src/metadata/peer-state.ts          # getMinSentWatermark; reworded NOTE in deletePeerState
  - packages/quereus-sync/src/metadata/keys.ts                # prefixBounds now exported (not re-exported from index.ts)
  - packages/quereus-sync/src/sync/manager.ts                 # pruneTombstones doc comment
  - packages/quereus-sync/src/sync/protocol.ts                # retentionHorizonMs doc comment
  - packages/quereus-sync/test/sync/prune-unpushed-tombstones.spec.ts   # new
  - packages/quereus-sync/test/sync/_peer-harness.ts          # markAllDelivered helper
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - docs/sync.md
  - docs/sync-transactions.md
repro: verified
----

## What changed

A tombstone (the record that a row was deleted) is also the only way a local delete reaches the server: `getChangesToPush` reads the change log past the sent watermark (the highest timestamp the server has acknowledged, stored per server under `pt:`) and resolves each delete entry through its tombstone. `pruneTombstones` used to remove tombstones on age alone, so a device offline past `retentionHorizonMs` lost its own undelivered deletes.

`pruneTombstones` now keeps a tombstone, whatever its age, when this replica wrote it (`tombstone.hlc.siteId` is this site) and it is not yet delivered: no `pt:` record exists, or its timestamp is above the lowest sent watermark across all `pt:` records (`PeerStateStore.getMinSentWatermark`). Everything else expires by age. Hosts need no change: `SyncMaintenanceTarget` and the quoomb-web worker are untouched.

The rule and its limits are stated once in `docs/sync.md` § Tombstones and Deletions; the other doc passages link there. The two `NOTE:`s the ticket asked for are in `pruneTombstones` (a replica that never pushes keeps its own tombstones forever) and `deletePeerState` (a leftover `pt:` record is no longer inert).

## Tests added (`prune-unpushed-tombstones.spec.ts`)

- `keeps an expired delete above the watermark, and still pushes it`: the bug's reproduction. After the prune, the delete is still pending and removes the row from a stand-in server.
- `keeps an expired delete when no push has ever been acknowledged`: the no-watermark arm.
- `prunes on the sweep after the watermark reaches it, raising the floor only then`: the tombstone is not kept forever, and the delta floor stays unset until the prune that removes it.
- `goes by the lowest watermark when several servers have one`: three `pt:` records with fixed ids place the lowest between the other two, so a "first wins" or "last wins" scan fails regardless of key order.
- `another device's expired delete` / `prunes on a device with no watermark, which only receives`: other devices' deletes still expire on a receive-only device.
- `another device's expired delete` / `prunes on a device whose watermark is below it`: the same when a watermark exists but is lower.

The 9 existing tests the ticket listed now declare the delete delivered through `markAllDelivered` and keep their assertions.

## Validation

- `yarn build` and `yarn typecheck` pass.
- `@quereus/sync` 845 passing, `@quereus/sync-client` 106 passing, `@quereus/sync-coordinator` 138 passing. The last two had not been run against the rule before this.
- Mutation checks, source restored afterwards: forcing the predicate to always answer "not undelivered" fails the 4 keep tests; removing the own-tombstones check fails the 2 foreign-delete tests.
- Not run: the full `yarn test` across all workspaces, and `yarn lint` (only `packages/quereus` has a real lint, and this ticket does not touch it).

## Differences from the ticket

- `markAllDelivered` uses `{ ...getCurrentHLC(), opSeq: MAX_OPSEQ }` rather than the ticket's plain `getCurrentHLC()`. `HLCManager.now()` returns `opSeq` 0, so a transaction deleting several rows would have its later deletes compare above that watermark and stay. This comes from reading the code; I did not run the plain form. `deleteAndPrune(sender, 'id in (1, 2)')` is the case it matters for.
- `deleteAndPrune` now asserts the prune removed something, and the `settings` test at `snapshot-replaces-rows.spec.ts` asserts exactly 1. These tests kept passing silently once pruning stopped happening, so they can no longer do that. The assertion in `deleteAndPrune` is only "more than zero", so it would not notice a multi-row delete pruning partly.
- The `retentionHorizonMs` comment in `protocol.ts` was updated too, to match the copy in `docs/sync.md`.
- `getAllPeers` now shares `prefixBounds` from `keys.ts`, which had to be exported.

## Known gaps for the reviewer

- **A server met for the first time is not counted.** It has no `pt:` record, so a device with a watermark from server A can prune own tombstones below A's watermark before server B has them. Recorded in the `getMinSentWatermark` comment and in `docs/sync.md`; no test covers it. I did not assess how often a device moves between servers that share data.
- **No end-to-end run.** The new tests drive the manager API with a stand-in server and set the watermark by hand. Nothing here runs a real `SyncClient` against a coordinator through a prune, and the quoomb-web worker was not exercised.
- **"Delivered" means what the push read means.** The rule compares against the watermark the same way `getChangesToPush` does, so an own write with a timestamp at or below the watermark counts as delivered. The sync client sets the watermark from the batch's highest timestamp, which can include a forwarded held change from another device. I relied on the ordering argument at `buildChangeSetsForPeer` and did not test that combination. Such a write was already never pushed before this change.
- **From reading the code, not tested:** a late delete gets a full retention period on the server (`change-applicator.ts` calls `setTombstoneBatch`, which defaults `createdAt` to now); `pt:` survives a snapshot apply (the clear touches only `cv:`, `tb:` and `cl:`), so own tombstones arriving in a snapshot compare against the surviving watermark.
- **Left out on purpose, per the ticket:** own tombstones of a dropped table get no special case, and a third device whose received watermark is already past the delete still misses it (`backlog/bug-sync-late-push-skipped-by-newer-watermark`).
