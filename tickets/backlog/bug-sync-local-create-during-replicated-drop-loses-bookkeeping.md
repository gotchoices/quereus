description: If someone re-creates a table locally at the instant a drop of that table arrives from another device, the new table's rows can lose their sync records and never reach other devices.
architecture: docs/sync.md#table-identity
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitMetadata: retires from the executed list, after draining local commits
  - packages/quereus-sync/src/metadata/table-identity.ts       # ensure() returns the existing generation; retire() purges it
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # applyLocalTableTransitions: the local create
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The window is short and needs a local re-create of the exact table being dropped remotely, so a maintainer might defer this until the crash gap at the same site is fixed, since both point at deciding the transition against the catalog.
----

# A local re-create in the gap before a replicated drop retires its table

Each table's sync records are filed under a per-device random identity called a generation. A drop retires the generation and deletes its cell versions and tombstones. A re-create gets a fresh generation, so it inherits nothing.

Applying an inbound drop takes two separate steps. The engine runs `drop table t` first (`applyChanges` Phase 2). The sync layer retires `t`'s generation later, in `commitMetadata`, after draining the local commit queue.

A local `create table t; insert into t ...` that commits between those steps goes wrong in this order:

1. The local capture calls `ensure` for `t`. The name still maps to the old generation, so the new table inherits it, and its rows are filed under it.
2. The drain waits for that capture to finish.
3. `commitMetadata` retires the generation, because the drop is on the executed list. That deletes the new table's cell versions and tombstones along with the old table's.

## Expected behaviour

The new table keeps its own generation and its records, and its rows reach other devices. Nothing of the dropped table's history blocks them.

## Actual behaviour (from reading the code)

The new table's rows stay in the local store with no sync records, so they ship in neither a delta nor a snapshot. The name then has no generation, so the next write to `t` mints a new one, which covers only the cells that write touches. Rows untouched since the re-create stay unsynced.

This predates `sync-retire-dropped-table-bookkeeping`, when the records were orphaned rather than deleted. Deleting them makes the loss unrecoverable.

## Relation to other work

The NOTE in `commitMetadata` and `docs/sync.md` § Table identity already document a crash gap at this site: the transition comes from the executed list rather than from the catalog. This is a second consequence of that choice, with no crash involved.

## To confirm

This has not been run. To confirm it, make the `applyToStore` callback of a two-peer setup run a local `create table` + `insert` after the inbound drop executes and before it returns. Then check that the new rows have `cv:` records, and that they reach the other peer.
