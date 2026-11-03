description: If a row was written before sync was attached and is then edited, sync sends only the edited column, so every other device receives the row with its other columns empty, even required ones. The first edit of such a row should record the whole row, as an insert does.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions (~1179): the change goes here
  - packages/quereus-sync/src/metadata/column-version.ts # add a one-entry existence read beside getRowVersions (~254)
  - packages/quereus-sync/src/sync/staged-transaction-metadata.ts # rowState: cells this transaction has already staged
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # firstUnrecordedKey comment (~113) needs updating
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts # tests go here; makePeer's beforeSync option builds an unrecorded row
  - docs/sync.md
repro: verified
----

## What happens

An update records only the columns it changed. A row written before sync attached has no cell records (the per-column sync metadata), so its first edit produces one cell with no before-image, which looks like a first write. Every other replica then materializes the row from that one cell.

The results below use `orders (id integer primary key, note text not null, qty integer not null)`, real clients and a real coordinator, under default options unless stated. "Today" was run at HEAD and "With the fix" against a throwaway prototype of the design below, since removed.

| Ordering | Today | With the fix |
|---|---|---|
| One row, edited before connecting | A and new device C get `(9, 'nine2', NULL)` | All hold `(9, 'nine2', 9)` |
| Rows 9 and 10, only 9 edited | Same fragment for 9; 10 stays on D only | 9 whole; 10 stays on D only |
| Edit after connecting (D also held a recorded row, so no refusal) | `(9, NULL, 90)` on A and C | `(9, 'nine', 90)` on A and C |
| `unrecordedRows: 'adopt'`, 9 edited, 10 untouched | Fragment for 9, because adoption skips a row with any record; 10 whole | Both whole |
| Row deleted and pruned on the server, then edited on D | C gets `(9, 'nine2', NULL)`; A has no row | C gets `(9, 'nine2', 9)`; A has no row |
| Same key on the server from an older write | Merged: `(9, 'nine2', 1)` | D's row wins: `(9, 'nine2', 9)` |
| Delete of an unrecorded row: before connecting with no peer holding it, and after connecting with a peer holding that key | Clean: no fragment, and the row is gone from every replica | Same; no change needed |
| No-op update (`set note = note`) | Nothing recorded; row still counts as unrecorded | Same |

In the pruned-delete row, the whole row returning while A stays deleted is the same outcome as a re-sent insert (`bug-sync-resent-insert-returns-pruned-row`) and already a listed cost of adoption. In the same-key row, D's untouched cells beating an older server value is also a listed cost of adoption. Both follow from the settled design and need documenting, not fixing.

In the second row, row 10 staying on D is unchanged behaviour. A device with any change fact is not empty, so no bootstrap and no `unrecordedRows` check runs, and the row stays local until `snapshot_required`, which then refuses. Say so in the docs.

## The fix

A local **update** of a row with no cell records records every column, with no before-image. The HLC, change-log and event handling match an insert. Detection, in `recordColumnVersions`:

1. Work out the changed columns as today. None changed: record nothing and read nothing, so a no-op update leaves the row unrecorded for the `unrecordedRows` check to find.
2. Read each changed cell's prior version as today (overlay first).
3. Record the whole row only when `oldRow` is present, **every** changed cell has no prior, this transaction has staged no cell for the row (`staged.rowState(...)?.stagedColumns.size`), and the committed store has none (the new existence read).
4. Otherwise record the changed columns exactly as today.

Add `ColumnVersionStore.hasRowVersions(schema, table, pk)`: the bounds from `buildColumnVersionScanBounds`, `limit: 1`, false when the table has no generation. Reusing `getRowVersions` would JSON-parse every cell of a row that has them.

The overlay check in step 3 matters because `alter primary key` re-files a row's cells into the transaction's batch. Committed storage then shows nothing under the new key, while the overlay holds them.

Keep the existing comments in that function (compare by value, overlay reads, why a key cell never carries a before-image); they still apply. Split it into small functions rather than growing the loop.

## What it costs (measured)

KV reads per local update, counted by wrapping `kv.get` and `kv.iterate` on a peer, HEAD against the prototype without the snapshot guard rejected below:

| Update | Today | With the fix |
|---|---|---|
| Recorded row, 1 or 2 columns changed | 1 or 2 `get`, 0 `iterate` | Same |
| Unrecorded row, first edit | 1 `get`, 0 `iterate` | 1 `get`, 1 `iterate` (one entry at most) |
| Same row, second edit | 1 `get`, 0 `iterate` | Same |
| No-op update | 0 | 0 |
| Recorded row, first write of a column added since | 1 `get`, 0 `iterate` | 1 `get`, 1 `iterate` |

So the ordinary update pays nothing: the first changed cell found settles it. The extra read happens at most once per row, or once per row and added column. A bulk backfill of an added column pays one bounded read per row. Wall-clock time was not measured.

## Moments when a row only looks unrecorded

Three were probed, because adoption treats these moments as dangerous. None needs a guard here. Unlike adoption, this path stamps one row the app is editing, and in each case the result is no worse than today:

- **Between an apply writing rows and filing their records.** Forced by running a local update inside `applyToStore`. The whole row is stamped, then the apply's metadata overwrites those cells, so the stored cells match today's. A push landing inside that window would carry the whole row instead of one cell. Later pushes re-send the overwritten cells: run, today with one cell (`qty`) and with the fix with all three. From reading `collectChangesSince` and `resolveLogEntry`, not run: the leftover change-log entries pass the push filter on their local timestamp but resolve to the cell's sender timestamp, so receivers should treat them as duplicates. Those entries break the invariant documented on `collectChangesSince` (a log entry's timestamp equals its cell's), as the edited cell's entry already does today; the fix widens that from one entry to one per column in this window. Leave a `NOTE:` at the site. The edited cell itself diverges today and with the fix: `bug-sync-local-edit-during-apply-diverges`.
- **During a streaming snapshot, once its header has cleared the metadata.** A row the snapshot still carries is overwritten by that table's flush, and one already flushed has cells. A row absent from the snapshot survives as today, with the edit keeping it alive, and is pushed whole rather than as a fragment. A guard on "a checkpoint exists" was prototyped and rejected: it costs a second read and sends the fragment this ticket removes. Writes during a transfer stay the gap `feat-sync-bootstrap-write-gate` tracks.
- **`alter primary key` then an update in one transaction.** With a changed cell that has a record, correct as today (run). The case needing the overlay check in step 3 was not run; see the TODO.

Also run: insert-then-update and delete-reinsert-update in one transaction are unaffected, two updates in one transaction record the row once, a rolled-back update records nothing, and a case-only key rewrite under `NOCASE` records the whole row.

The prototype passed the existing suites: `@quereus/sync` (817 existing tests), `@quereus/sync-client` (106) and `sync-coordinator` (138).

## What this does not cover

- **A table only this device has, created before sync attached.** The whole row reaches the server, but with no `create_table`, so a new device's snapshot still fails. An insert does the same, so the cause is separate: `bug-sync-write-to-unannounced-table-strands-new-devices`.
- **Fragments already stored** on a server, or a device's row that already has a partial set of cells, are not repaired.

## TODO

- Add the reproduction to `unrecorded-rows.spec.ts`: a peer with a row from `beforeSync`, one edit, `relay` to a second peer; assert the receiver holds the whole row and the change carries no before-image. It fails at HEAD.
- Add tests for the branches that decide the outcome: a no-op update records nothing and the row is still reported by `findTablesWithUnrecordedRows`; a recorded row's first write of a later-added column records only that cell; `alter primary key` plus a write to such a column in one transaction records only that cell. Confirm the last one fails without the overlay check, and drop the check and the test if it does not. An added column must be declared `null`: columns are not nullable by default.
- Add `hasRowVersions` and change `recordColumnVersions` as above.
- Add `NOTE:` comments at the whole-row decision: the apply window (if a push ever lands inside it and shows up as clobbered concurrent edits, have capture wait or skip while an apply is in flight), and that a snapshot's cleared metadata reaches this path too, pointing at `feat-sync-bootstrap-write-gate`.
- Update the `firstUnrecordedKey` comment in `unrecorded-rows.ts`: a recorded row has at least one cell because capture records every column of an inserted row, and of the first edit of an unrecorded one.
- Update `docs/sync.md`: replace the "A row sync never recorded" bullet under *Tombstones and Deletions* (it names this ticket) with the re-sent-insert behaviour. Under *Rows sync has never recorded*, say that the first edit records the whole row, that its cells then win over older server values as adopted rows do, that a no-op update changes nothing, and that the device's other unrecorded rows stay local until `snapshot_required`. Amend "Only never-recorded rows count".
- Run the `@quereus/sync`, `@quereus/sync-client` and `sync-coordinator` suites. Coordinator tests load `@quereus/sync` from `dist`, so run `yarn workspace @quereus/sync exec tsc -b` first.
