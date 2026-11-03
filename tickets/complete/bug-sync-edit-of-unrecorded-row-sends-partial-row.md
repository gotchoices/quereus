description: If a row was written before sync was attached and is then edited, sync used to send only the edited column, so other devices received the row with its other columns empty. The first edit of such a row now records the whole row, as an insert does.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordColumnVersions, priorCellVersion, isFirstEditOfUnrecordedRow
  - packages/quereus-sync/src/metadata/column-version.ts # hasRowVersions
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # firstUnrecordedKey and adoption now use hasRowVersions
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts # describe('editing a row')
  - docs/sync.md
  - docs/sync-transactions.md
repro: verified
----

## What changed

A local update of a row with no cell records (the per-column sync metadata) now records every column with no before-image. `recordColumnVersions` works out the changed cells and reads their priors as before, then asks `isFirstEditOfUnrecordedRow`. It answers yes only when something changed, no changed cell has a prior, this transaction has staged no cell for the row, and the new `ColumnVersionStore.hasRowVersions` finds no committed cell. Otherwise the changed columns are recorded as before. An insert has no `oldRow`, so it never asks.

Behaviour is documented in `docs/sync.md` under *Rows sync has never recorded*, and in the *Tombstones and Deletions* bullet. `docs/sync-transactions.md` has a matching line in its capture pseudocode.

Not repaired: fragments already stored on a server, and a device's row that already has a partial set of cells.

## Review findings

Reviewed the diff of `ticket(implement): bug-sync-edit-of-unrecorded-row-sends-partial-row`, then ran throwaway specs (deleted afterwards).

### Found and fixed in this pass

- **Lost edit on shared seeded rows was undocumented.** Two devices seeded with the same row, A editing `note` and then D editing `qty`, both end at `(9, 'nine', 99)`: A's edit is gone. With the whole-row path disabled, the same run keeps both edits, `(9, 'from-a', 99)`. So this case got worse while the fragment case got better. It follows from the settled design (untouched cells take the edit's time, as adopted rows do), and the docs named only "older server values". Added to `docs/sync.md`, with a `NOTE:` tripwire on `isFirstEditOfUnrecordedRow`. **A maintainer may want to weigh this one:** no ticket filed, because the ticket that specified this design said that cost needs documenting rather than fixing.
- **Doc bullet read as if adoption stops.** "No bootstrap or check runs" for the device's other unrecorded rows is not true of `'adopt'`, which runs on first contact whatever the device holds (`sync-client.ts`). Added a clause.
- **Two ways of asking one question.** `firstUnrecordedKey` and the adoption scan parsed every cell of every recorded row to test for emptiness. Both now call `hasRowVersions`; this was not measured. The timing test in `unrecorded-rows.spec.ts` that hooks this read moved with it.
- **Stale comment.** `recordDataEvent`'s doc said only changed columns are recorded.

### Implementer's open gaps, now closed

- **End-to-end table:** re-run on the final code with real clients and a real coordinator (columns declared `null`). Every row checked matches the ticket:
  - Edit before connecting, edit after connecting, and a new device: whole row everywhere.
  - Rows 9 and 10 with only 9 edited: 9 whole, 10 stays on D, and D still reports the table as unrecorded.
  - `'adopt'`: both rows whole.
  - Pruned delete: D and a new device hold `(9, 'nine2', 9)`, A has no row.
  - Same key on the server: D's row wins.
- **Delete rows of that table:** not re-run; the code path for deletes is unchanged.
- **Local update during a remote apply:** forced from inside `applyToStore`, then relayed to a third peer. The leftover change-log entries resolve to the sender's timestamp. A push excluding the sender sends nothing, and the third peer reports 3 conflicts, 0 applied, so the claim that receivers treat them as duplicates now has a run behind it. The row disagreeing with its records is the existing `bug-sync-local-edit-during-apply-diverges`.
- **Local update during a streaming snapshot:** a row absent from the snapshot, edited after the header, survives and is pushed whole, as the `NOTE:` says.
- **Overlay check and committed read:** with each neutralized in turn, `qty` is re-stamped, so both are needed and their tests have teeth.
- **Bulk backfill cost:** measured, 5000 recorded rows with an added column, three rounds each. On LevelDB, about 350 ms without the read and 360-730 ms with it (noisy). On `InMemoryKVStore`, about 190 ms against 87 s, because it sorts the whole store on every iterate. That store already carries a `NOTE:` on this and serves tests and build-time seeds, so it is not a production cost. Parked as a `NOTE:` on `isFirstEditOfUnrecordedRow`.
- **Cleared rows:** an update straight after a delete with no reinsert stays unreachable on the store module, because a relocating update is split into delete plus insert (`store-table.ts`) and an in-place update needs a live row. Other modules were not checked. No code or test added.

### Checked, nothing wrong

- **Correctness:** rename plus update in one transaction keeps the recorded row's other cells, because the generation moves in memory before data events run. An upsert of an unrecorded row records the whole row. A no-op update on a row shorter than its table's columns (column added before or after sync) stays a no-op, and a no-op on a recorded row re-stamps nothing.
- **Resource cleanup:** `hasRowVersions` returns from inside `for await`, which closes the iterator.
- **Type safety:** no casts or `any` added. Typecheck clean.
- **Performance of ordinary updates:** the ticket's read counts stand, and the extra read runs only when no changed cell has a prior.
- **Tests:** the four added tests each pin a branch that decides the outcome. None cut, none added: the defects found were documentation, and the rest was verified by run.
- **Docs:** read `docs/sync.md`, `docs/sync-transactions.md`, and the `unrecordedRows` passages of `docs/sync-protocol.md` and the sync-client README. The last two needed no change.

### Tripwires (parked as `NOTE:` on `isFirstEditOfUnrecordedRow`)

- A local update in the apply window. Left by the implementer; now also run, as above.
- A row edited during a streaming snapshot. Left by the implementer.
- Backfill cost of the committed read. New.
- Later edit overwriting an earlier one on shared seeded rows. New.

### Not addressed

- `sync-manager-impl.ts` is 1,964 lines by `wc -l` at the start of this review, and this ticket grew it. No ticket filed: the new code is three small methods and nothing here calls for a split.
- Nothing filed. `bug-sync-write-to-unannounced-table-strands-new-devices` and `bug-sync-local-edit-during-apply-diverges` already track the neighbouring defects.

## Validation

`yarn workspace @quereus/sync exec tsc -b` first, then: `@quereus/sync` 821 passing, `@quereus/sync-client` 106 passing, `sync-coordinator` 138 passing. `@quereus/sync` typecheck clean. That package has no real lint (`yarn lint` is a no-op there).
