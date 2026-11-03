description: Added a client option that keeps data a device held before sync was turned on, by recording those rows as ordinary local changes so they reach the server and every other device. Quoomb Web turns it on, since someone switching from "store" to "sync" almost certainly wants to keep their data.
prereq: sync-unrecorded-rows-refuse, sync-push-drains-all-local-changes
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # adoptUnrecordedRows, adoptTable, receiversCanWrite, missingCreateEvents, hasLiveCreate
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch split, adoptOnCommitChain, appliesDrained, snapshot applies wait
  - packages/quereus-sync/src/sync/manager.ts # interface, AdoptedRows
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # scanLiveKeys renamed scanLiveColumns
  - packages/quereus/src/core/database.ts # _isImplicitTransaction lost @internal
  - packages/quereus-sync-client/src/sync-client.ts # settleUnrecordedRows, adoptUnrecordedRows, isFirstContact, maybeBootstrap
  - packages/quereus-sync-client/src/types.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts # connectSync sets the option; status changes reach the UI
  - packages/quereus-sync/test/sync/unrecorded-rows.spec.ts
  - packages/quereus-sync/test/sync/_peer-harness.ts # beforeSync option
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts
  - docs/sync.md
  - docs/sync-protocol.md
  - packages/quereus-sync-client/README.md
----

## What was built

`SyncClientOptions.unrecordedRows` gains `'adopt'`, and `SyncManager` gains `adoptUnrecordedRows()`. Under `'adopt'` a device's rows from before sync attached are recorded as ordinary local changes and pushed, together with `create_table` and `add_index` migrations for what no migration announces, so other devices and brand-new devices receive them. Quoomb Web's `connectSync` sets it.

Adoption runs on first contact with a server and on every `snapshot_required`, ahead of the recovery's push. A device that adopted rows skips the bootstrap. A failed adoption takes no snapshot and retries through the reconnect. A pending checkpoint or a running transfer skips adoption, and `'adopt'` with `readOnly` throws in the constructor.

Deliberate differences from the implement ticket:

- `hasLiveCreate` walks an object's migrations instead of testing `getCurrentVersion === 0`, which misses alter-only and drop-ended histories.
- The index migration type is `add_index`; `create_index` does not exist.
- A live row with a tombstone does not beat it under the default `allowResurrection: false`. It behaves as a local reinsert does. Read from `TombstoneStore.isDeletedAndBlocking`, not run.
- Snapshot applies wait for adoptions under way, adoption refuses inside an explicit transaction (so `_isImplicitTransaction` lost `@internal`), the manager also refuses a pending checkpoint, and applies drain before the chain entry is appended.

## Testing notes

`yarn build`, `yarn lint`, and `typecheck` for `@quereus/sync`, `@quereus/sync-client`, `@quereus/sync-coordinator` and `@quereus/quoomb-web` pass after the review changes. Tests: `@quereus/sync` 802, `@quereus/sync-client` 106, `@quereus/sync-coordinator` 136, all passing. `@quereus/quereus` tests were not run in either stage: its only change is a doc comment, and removing the tag changes the published types, which the build covers.

The implement stage ran Quoomb Web in headless Chromium against a real coordinator: store mode to sync, a fresh profile receiving the table and rows, a write coming back, and the first profile keeping everything after a reload. That run predates the review changes, and the review did not repeat it.

## Review findings

Read the implement diff first, then ran throwaway specs against real peers (deleted afterwards).

**Fixed in this pass:**

- **Receivers lost indexes (bug, verified).** A table created before sync attached with an index created under sync has an old `add_index` and no create. Adoption announced only the table, so a receiver replayed the `add_index` first, found no table, and converged without the index. Both a delta and a snapshot receiver ended with the rows and `indexes` undefined. A table dropped under sync and re-created while detached did the same, because `drop table` records no `drop_index`. `missingCreateEvents` now announces every index of a table it announces. Pinned by a new test covering both receiver kinds.
- **A custom-module table stopped its receivers (bug, verified).** A table `using plugin` was adopted with its DDL, and the receiver's `applyChanges` threw `No virtual table module named 'plugin'` for the whole batch, the failure this ticket exists to prevent. Per the `NOTE` on `removeRowsAbsentFromSnapshot`, such a table cannot sync in any direction, and the apply path writes only to store tables. `receiversCanWrite` now skips those tables with a warning, using the ownership rule of `getTableForExternalWrite`. The `refuse` scan is unchanged. Pinned by a new test on the sending side; the receiver failure itself was seen only in the throwaway.
- **Quoomb's status stuck on "Syncing (0%)".** The implementer left this for review. The UI re-reads status only on a `state-change` event, and the client's move to `synced` emits none. The worker now emits one when the status value changes, which adds one row per transition to the events panel. Typechecked and built, **not run in a browser**.
- **Duplicated types.** The adoption result shape was written out five times, and the client resorted to `Awaited<ReturnType<...>>`. It is now the exported `AdoptedRows`, and `tablesToCheck` has a named `CheckedTable`.
- **Docs.** `docs/sync.md` said adoption "scans each table once", which was wrong. It now also says a row written while detached after the first ack stays local until a `snapshot_required`, gives the index rule, and says only store tables are adopted.

**Tripwires parked as `NOTE:`** (one added here, the rest from the implement stage, checked and kept):

- Streams that read live after the object has gone: a table renamed away, or a dropped table's index stream, so a same-named object created while detached is not announced. Added at `hasLiveCreate`. From reading the code; only the drop-and-re-create-while-detached index case was run, and the fix above covers that one.
- A table created before sync attached and renamed since reaches receivers with no create. `hasLiveCreate`.
- First push after adoption reads every local change into memory. `sync-client.ts`, adoption call site.
- The emptiness probe materializes adopted rows on a reconnect before the first `changes` reply. `isReplicaEmpty`.
- More than 10 columns (default settings) makes each batch an oversized transaction. `adoptTable`.
- The app's writes wait for each table's scan on the store module, not measured. `adoptTable`.
- An unbroken run of overlapping applies keeps a first attach waiting. `appliesDrained`.

**Checked by reading, no defect:**

- Whether something could set peer state mid-adoption and so stop the retry: the local-change subscription starts after `maybeBootstrap`, and a `push_changes` broadcast does not advance the watermark, so a failed first adoption is still first contact on the reconnect.
- Deadlocks: applies drain before the chain entry is appended with no `await` between. A later apply waits on the chain, a snapshot apply waits on `adoptionsInFlight`, and snapshot applies are not in `appliesInFlight`, so the waits cannot form a cycle.
- `adoptionsInFlight` is assigned synchronously and the client's transfer check has no `await` before the manager call, so a transfer either blocks adoption or waits for it.
- Alter-only history on a new device: run, not just read. Delta and snapshot receivers both ended with the current shape and the rows.
- A second adoption scan in `maybeBootstrap`, when the first found nothing and the replica is empty, is redundant but cheap: an empty replica has no rows left to look up.

**Known gaps, not fixed:**

- Two devices adopting tables with the same name and different shapes conflict on `assertDefinitionMatches`, which blocks the receiver's batch until someone intervenes. Documented as a cost. Inferred from the code, not run.
- No end-to-end test of a real delta floor refusal under `'adopt'`, only the mock-based client test and the implementer's throwaway, which called the handler directly.
- A definition captured before a table's scan can go stale if an `alter table` lands between tables during a run. A dropped table fails the run and retries. An added column would record the row without that cell. Not run and not parked at a site, since it needs DDL during a first attach.

**Tests:** kept the implementer's. Each pins a stated behaviour or race, and none verifies only a mock. Added the two above, plus a function form of the harness's `beforeSync` so a test can register a module.

**Tickets filed:** none. Both defects were fixed here, and the rest are tripwires or documented costs. `sync-client-pushes-back-server-changes` in `fix/` is separate work on the same push path, and this review does not depend on it.

`.release-notes.pending.md`, which is git-ignored, has the new option and the new `SyncManager` method from the implement stage. It was not updated for `AdoptedRows`.
