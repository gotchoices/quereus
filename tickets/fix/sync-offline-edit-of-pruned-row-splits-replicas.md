description: If a device edits a row while offline and that row gets deleted elsewhere and forgotten by the server, the device's edit brings back a fragment of the row. Devices then permanently disagree, and a new device can receive a row with empty values in columns declared as required.
architecture: docs/sync-protocol.md#client-snapshot-bootstrap
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # applying a column change for a row with no cells and no tombstone; the before-image (priorHlc) arrives at ~1002
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # getChangesToPush; local writes record priorHlc at ~1228
  - packages/quereus-sync/src/sync/snapshot-stream.ts # how a bootstrap builds a row from a partial set of cells
  - packages/quereus-sync/src/sync/snapshot.ts
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # the neighbouring reproduction, "a device returning past a pruned delete"
  - docs/sync-protocol.md
  - docs/sync.md
repro: verified
----

## What happens

Run through real clients against a real coordinator, using a throwaway spec modelled on "a device returning past a pruned delete" in `sync-coordinator-roundtrip.e2e.spec.ts`:

1. A inserts rows 1 and 2. B receives them by broadcast and disconnects.
2. B runs `update orders set note = 'edited offline' where id = 1`.
3. A deletes row 1. The server applies the delete and prunes the tombstone.
4. B reconnects. It pushes its own `note` cell for row 1, is refused its old watermark with `snapshot_required`, and takes a snapshot.
5. A new device C connects and bootstraps from the server.

The table was `orders (id integer primary key, note text, qty integer)`, and also `note text not null, qty integer not null`. The results were the same for both:

| Replica | Row 1 |
|---|---|
| A | no row (its tombstone blocks the cell) |
| B | `(1, 'edited offline', 1)` |
| Server | one cell only, `note = 'edited offline'` |
| C | `(1, 'edited offline', NULL)` |

No error or event was reported on any device. All three clients show `synced`. C holds a null in a `not null` column.

B's `qty = 1` is now also a value with no sync record, since the snapshot cleared B's metadata for it. No later sync touches it unless someone writes that column.

## Why this ticket exists now

`sync-client-pushes-back-server-changes` made devices push only their own writes. Its ticket listed "a device's own older write can still return a row whose tombstone the server pruned" as not addressed and not run, on the picture that a whole row returns. Running it shows a fragment returns instead.

Before that change, the device's push also carried the row's other cells whenever its sent watermark was below them, which would have given the server a whole row. That comparison comes from reading the old read path, and was not re-run for this exact scenario. The disagreement between A and B is not new: the older ticket's table shows it for a row B never edited. When B's sent watermark was already above the other cells, the old code should have produced this same fragment. So the change makes an existing outcome the usual one rather than creating it.

## Expected behaviour

Replicas converge, and no replica materializes a row missing cells it never had a chance to receive. Which row state they converge on is the decision here. `docs/sync.md` says delete wins "until the tombstone is pruned at the retention horizon", which does not settle what an older edit should do afterwards.

Useful starting point, from reading the code and not tried: a device's update of an existing cell carries a before-image (`priorHlc`), recorded in `recordDataEvent`. A server holding no cell and no tombstone for that row, receiving a cell whose before-image says the writer saw an earlier version, can tell that this is not a fresh insert: the row existed and it has no record of it. That may be the signal that makes the case detectable at apply time, without keeping tombstones longer. It does not cover a device that re-sends its original insert after losing the acknowledgement, which carries no before-image.

## Reachability

It needs a device offline past the point where the server prunes the tombstone (`retentionHorizonMs`, 30 days by default) that also edited a row another device deleted in that window. Any write to the row's cells will do, so the lost-acknowledgement path may reach it too; that path has not been run.

## Related

- `docs/sync-protocol.md` § Client snapshot bootstrap describes this limit and names this ticket. Update that sentence when this lands.
- `bug-sync-client-prunes-unpushed-tombstones` is the same offline-past-the-horizon situation, on the device's side rather than the server's.
