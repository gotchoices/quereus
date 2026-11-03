description: If a row was written before sync was attached and is then edited, sync used to send only the edited column, so other devices received the row with its other columns empty. The first edit of such a row now records the whole row, as an insert does.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions, priorCellVersion, isFirstEditOfUnrecordedRow
  - packages/quereus-sync/src/metadata/column-version.ts # hasRowVersions
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # firstUnrecordedKey comment only
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts # describe('editing a row')
  - docs/sync.md
  - docs/sync-transactions.md
repro: verified
----

## What changed

A local update of a row with no cell records (the per-column sync metadata) now records every column with no before-image. `recordColumnVersions` works out the changed cells and reads their priors as before, then asks `isFirstEditOfUnrecordedRow`. It answers yes only when all of these hold:

- something changed
- no changed cell has a prior
- this transaction has staged no cell for the row
- the new `ColumnVersionStore.hasRowVersions` finds no committed cell

Otherwise the changed columns are recorded exactly as before. An insert has no `oldRow`, so it never asks.

The write loop's body and comments are unchanged, apart from taking its cells from the decision above. Reads now happen before any write in the event, which does not change HLC order.

## Tests added

All are in `unrecorded-rows.spec.ts`, under `editing a row`:

| Test | What it verifies |
|---|---|
| records the whole row on the first edit of an unrecorded one | The reproduction: three cells, no before-image, receiver holds the whole row. Failed before the fix with `['note']` against `['id', 'note', 'qty']`. |
| leaves an unrecorded row unrecorded when an update changes nothing | No-op update: nothing to send, and `findTablesWithUnrecordedRows` still names the table. |
| records only that cell (recorded row, column added since) | Every changed cell lacks a prior, but the committed read stops the whole-row path. `qty` keeps its HLC. |
| records only that cell when the same transaction re-keys the table | `alter primary key` plus such a write: the overlay check. Ran with the check neutralized and this test failed (`qty` was re-stamped), so the check and the test both stay, as the ticket required. |

## Validation

- `@quereus/sync` 821 passing (817 existing plus these 4), `@quereus/sync-client` 106, `sync-coordinator` 138. `yarn workspace @quereus/sync exec tsc -b` ran first. Typecheck clean.
- `@quereus/sync` has no real lint configured (`yarn lint` is a no-op for that package).
- A throwaway spec, since deleted, confirmed these on the final code. The reads were counted by wrapping `kv.get` and `kv.iterate`:

| Case | Result |
|---|---|
| Unrecorded row, first edit | 1 `get`, 1 `iterate` |
| Same row, second edit | 1 `get`, 0 `iterate` |
| Recorded row, 2 columns changed | 2 `get`, 0 `iterate` |
| No-op update | 0 reads |
| Recorded row, first write of an added column | 1 `get`, 1 `iterate` |
| Two updates in one transaction | Row recorded once; the later cell chains its before-image |
| Delete, reinsert, update in one transaction | Tombstone plus a full cell set |
| Rolled-back update | Nothing recorded |
| Case-only key rewrite under `NOCASE` | Whole row recorded; receiver holds the row |

The first row reads nothing when it is the table's very first write under sync: with no generation, both reads return early. The ticket's table did not cover that case.

## Known gaps, for the reviewer to check

- **The ticket's end-to-end table was not re-run.** Its rows with real clients and a real coordinator (edit before and after connecting, `unrecordedRows: 'adopt'`, pruned delete, same key on the server) came from the removed prototype. The final code implements the same decision and the suites pass, but only the reproduction above exercises it, between two peers with no coordinator.
- **The two risky moments have no automated test and were not re-probed.** A local update during a remote apply and one during a streaming snapshot rest on the ticket's prototype probes. Its claim that leftover change-log entries are treated as duplicates by receivers was only ever read from `collectChangesSince` and `resolveLogEntry`, never run. Both are parked as `NOTE:` comments on `isFirstEditOfUnrecordedRow`.
- **Bulk backfill cost.** Writing a newly added column across a whole table pays one bounded `iterate` per row. Wall-clock time was never measured, and I left no `NOTE:` for it. Consider whether one belongs there.
- **Cleared rows.** A row this transaction cleared (a delete) with no cells staged since would reach the committed read and answer no. An update directly after a delete with no reinsert should be impossible, so nothing tests it.

## Usage and expected behaviour

Documented in `docs/sync.md` under *Rows sync has never recorded*:

- The first value-changing update records the whole row, and its cells win over older server values, as adopted rows do.
- A no-op update changes nothing.
- The device's other unrecorded rows stay local until `snapshot_required`, which refuses under the default.
- An edit announces no table, so a table only this device has still fails a new device's snapshot (`bug-sync-write-to-unannounced-table-strands-new-devices`).

The *Tombstones and Deletions* bullet now describes the re-sent-insert outcome instead of naming this ticket. `docs/sync-transactions.md` has a matching one-line change to its capture pseudocode.

Not repaired: fragments already stored on a server, and a device's row that already has a partial set of cells.
