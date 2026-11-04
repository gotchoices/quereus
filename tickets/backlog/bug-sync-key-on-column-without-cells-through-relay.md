description: If a table's primary key is changed to include a column that was added after its rows were written, a server with no database engine cannot work out the rows' new keys, so a new device cannot get those rows. The other devices are unaffected and nothing tells the person who made the change.
prereq: bug-sync-key-change-through-relay-diverges
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts # the relay's re-filing reads each row's new key from its stored cells
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordSchemaMigration; a column added with a default records no per-row cells
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a new column plus a key change on that column, on a relay deployment, and the fix means sending values for every existing row or refusing a statement that has already committed on the device, so a documented limit may be the better answer.
----

A relay is a server with sync records but no database engine. It works out a row's new key from the cells it stores for that row, which `bug-sync-key-change-through-relay-diverges` introduces. A column added by `alter table … add column` records no cell for existing rows, so the relay has nothing to read for them.

Observed with real clients and a real coordinator:

1. Devices A and B hold rows 1 and 2 of `orders (id integer primary key, note text, qty integer)`.
2. B runs `alter table orders add column region text default 'eu'`, then `alter table orders alter primary key (id, region)`.

A and B both end with rows 1 and 2 and `region = 'eu'`. What a new device gets depends on the relay:

| Relay behaviour | New device |
|---|---|
| Current code, which keeps records under the old key | Did not reach the synced state within the test's 3-second wait; the cause was not investigated |
| Prototype that dropped rows it could not re-file | Finished with an empty table and no error |

The second row is why the parent ticket leaves such rows in place instead of deleting them.

An existing device that takes a snapshot probably loses these rows too, because the parent ticket's snapshot case loses a row whose identity is missing from the snapshot. A key on a renamed column probably fails the same way, because the relay's cells keep the old column name. Neither of these two was run; confirm each by running the sequence.

Expected: every device holds the same rows after the key change, or the person making the change is told it cannot reach other devices.

Directions to weigh:

- The writer sends the missing key cells with its key change. The relay's pass runs before the batch's own records are filed, and it needs the old-to-new mapping per row, so this cost grows with the table.
- The relay falls back to the `add column` default from the recorded statement. This only works while no row has a value other than the default.
- Treat it as a documented limit, and report it to the writer through an acknowledgement from the relay rather than only in the relay's log.
