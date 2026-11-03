description: If a row was written before sync was attached and is then edited, sync sends only the edited column, so every other device receives the row with its other columns empty, even required ones.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions (~1179): an update records only the changed columns, even when the row has no cell records at all
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # a row with any cell record counts as recorded, so this row no longer trips the check
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The default `unrecordedRows: 'refuse'` already steers most such devices away from sync, and detecting the case adds a read of the row's cell records to the local update path.
----

## What happens

Run with real clients against a real coordinator, on `orders (id integer primary key, note text not null, qty integer not null)`:

1. Device D holds `(9, 'nine', 9)`, written before sync was attached, so sync has no record of it.
2. D runs `update orders set note = 'nine2' where id = 9`.
3. D connects with default options. Its status is `synced` and no refusal is raised.

| Replica | Row 9 |
|---|---|
| D | `(9, 'nine2', 9)` |
| Server | `note` cell only |
| A, B, and new device C | `(9, 'nine2', NULL)` |

The edit gives the row one cell record, so `findTablesWithUnrecordedRows()` treats it as recorded. The change carries no before-image, since no earlier cell record exists, so it looks like a first write. The rule added by `sync-offline-edit-of-pruned-row-splits-replicas` does not catch it.

This run had one row, edited before connecting. Other orderings were not run.

## Expected behaviour

No other replica materializes this row with cells missing. One option is for a local update of a row with no cell records to record every column, as an insert does and as adoption does for such rows. The other is to treat the row as unrecorded, so the `unrecordedRows` setting decides.

## Gardener note (2026-11-03)

Promoted ahead of the release because this reproduces under default options and silently defeats `unrecordedRows: 'refuse'`: other devices receive NULLs in `not null` columns.

Design settled unless research finds it unsound: a local update of a row with no cell records records every column, as an insert and adoption do. Also run the orderings the ticket did not (several rows, some edited; an edit after connecting; a delete of an unrecorded row) and cover what they find. Keep the added read on the local update path cheap, and report what it costs.
