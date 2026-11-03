description: If a device's new row reaches the server but the device never hears back, and another device deletes that row before the first device returns more than a month later, re-sending the row brings it back everywhere except the device that deleted it, which stays without it.
architecture: docs/sync-protocol.md#client-snapshot-bootstrap
files:
  - packages/quereus-sync-client/src/sync-client.ts # pushLocalChanges re-sends everything past the acknowledged watermark
  - packages/quereus-sync/src/sync/change-applicator.ts # resolveChange (~959): a first write for an unknown row is accepted
  - packages/sync-coordinator/src/service/coordinator-service.ts # applyChanges (~362): where a per-device record of what was applied could live
repro: verified
severity: wrong-result
likelihood: contrived
tradeoffs: It needs an acknowledgement lost just as a device goes offline for longer than the 30-day retention period, plus a delete of that same row in that window, and the candidate fix adds durable per-device state to the server.
----

## What happens

Run with real clients against a real coordinator. The lost acknowledgement was simulated by handing B's push to the coordinator's `applyChanges` directly, so B's sent watermark never moved.

1. B, offline, inserts row 5. The push reaches the server, but B never hears back.
2. A receives row 5 and deletes it. The server prunes the tombstone.
3. B reconnects and re-sends its insert, then takes the snapshot the server requires.
4. A new device C bootstraps.

| Replica | Row 5 |
|---|---|
| A | no row (its tombstone blocks the cells) |
| B | `(5, 'five', 5)` |
| Server | whole row |
| C | `(5, 'five', 5)` |

The row is whole, not a fragment, but A disagrees with everyone else with nothing reported, and the row the user deleted is back.

## Why the pruned-edit rule does not cover it

`sync-offline-edit-of-pruned-row-splits-replicas` refuses edits by their before-image. An insert has none, and it cannot be refused by age either: a device's real offline insert older than the server's last prune looks identical, and refusing it would destroy new work.

## Expected behaviour

Replicas converge. A candidate, not tried: the server keeps, for each device, the newest change it has applied from that device, and treats anything at or below that from the same device as already seen. A device pushes in timestamp order, so this would also recognise a re-send of a change the server has since forgotten.
