description: When a device changes a table's primary key and syncs through a server that has no database engine, devices end up with different data: the writer can lose its own edit, or lose whole rows.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts # rekeyTableBookkeeping: cannot run on a relay-only peer, so the server's records stay under the old key
  - packages/quereus-sync/src/sync/snapshot.ts # a snapshot from such a server mixes records under the old and new key
  - docs/sync.md # "What a key redefinition does not cover"
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: docs/sync.md already tells people to quiesce writes around a key change and says a relay cannot re-file its records, and a fix needs the relay to understand keys it currently treats as opaque values.
----

`docs/sync.md` says a relay-only server keeps its records under the old key after `alter table … alter primary key`, but does not say what that does to devices. Observed with real clients and a real coordinator, in this sequence:

1. Devices A and B both hold rows 1 and 2 of `orders (id integer primary key, note text, qty integer)`.
2. B disconnects, runs `alter table orders alter primary key (id, qty)`, then `update orders set note = 'edited after key change' where id = 1`.
3. B reconnects.

The server then holds cells for `[1]`, `[2]` and a separate `[1,1]` holding only the edited `note`. A shows row 1 edited and row 2 intact. B depends on whether the server has pruned a tombstone past B's watermark:

| Server state | B afterwards |
|---|---|
| Has not pruned | Row 1 is back to `note = 'one'` (B applied 7 changes on reconnect), so B lost its own edit while A kept it |
| Has pruned, so B takes a snapshot | Row 2 is gone, and B holds only row 1 |

The second row is the worse outcome, because a row nobody deleted disappears from one device.

Expected: after the key change every device holds the same rows with the same values, or the change is refused in a way the writer can see.

This is independent of the rule that refuses edits of forgotten rows. That rule deliberately exempts tables whose key was redefined, so the edit is accepted exactly as it was before the rule existed. The case was found while running that exemption end to end during review of `sync-offline-edit-of-pruned-row-splits-replicas`.
