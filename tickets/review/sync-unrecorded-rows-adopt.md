description: Add a client option that keeps data a device held before sync was turned on, by recording those rows as ordinary local changes so they reach the server and every other device. Quoomb Web turns it on, since someone switching from "store" to "sync" almost certainly wants to keep their data.
prereq: sync-unrecorded-rows-refuse, sync-push-drains-all-local-changes
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # adoptUnrecordedRows, adoptTable, missingCreateEvents, hasLiveCreate
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch split, adoptOnCommitChain, appliesDrained, snapshot applies wait
  - packages/quereus-sync/src/sync/manager.ts # interface
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # scanLiveKeys renamed scanLiveColumns
  - packages/quereus/src/core/database.ts # _isImplicitTransaction lost @internal
  - packages/quereus-sync-client/src/sync-client.ts # settleUnrecordedRows, adoptUnrecordedRows, isFirstContact, maybeBootstrap
  - packages/quereus-sync-client/src/types.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts # connectSync sets the option
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

Use cases to validate:

- **First attach.** A device with rows connects for the first time. Rows are recorded and pushed, no bootstrap runs, and the device keeps them. A device with nothing to adopt and an empty replica still bootstraps.
- **A brand-new device afterwards.** It bootstraps the table, its indexes and the rows, with no schema of its own.
- **`snapshot_required`.** Adoption runs first, whatever the peer state, then the push drains and is acknowledged, then the snapshot runs and brings the rows back.
- **Refusals and retries.** A failed adoption takes no snapshot and retries through the reconnect. A pending checkpoint or a transfer already running skips adoption. `'adopt'` with `readOnly` throws in the constructor.

## Validation

`yarn build`, `yarn lint`, and `typecheck` for `@quereus/sync`, `@quereus/sync-client`, `@quereus/sync-coordinator` and `@quereus/quoomb-web` pass. Tests: `@quereus/sync` 800, `@quereus/sync-client` 106, `@quereus/sync-coordinator` 136, all passing. `@quereus/quereus` tests were not run: its only change is a doc comment, whose tag removal changes the published types, which the build covers.

**Quoomb Web was run in a browser.** Headless Chromium through Playwright, driving the real UI of the built app against a real coordinator, in two isolated profiles: Persistent mode, create a table and rows, switch to Sync; a fresh profile in Sync mode shows the table and rows; a write on the fresh profile reaches the first; the first still holds everything after a reload. The script's checks match text anywhere on the page, which stale results could satisfy, so the rows after the switch, the fresh profile's rows and the write reaching the first profile were confirmed from screenshots. The check after the reload is that text match only. The Chrome DevTools server could not start, because another Chrome held its profile, so Playwright was used with its installed Chromium (revision 1234; this Playwright asks for 1228). The script was not kept.

**Throwaway specs, not kept:**

- Adoption records the same cells local capture records, and a device bootstrapped from it ends with the same rows, for: every column type, `nocase`, composite (out of column order), singleton, blob, real, key-only and descending keys, generated columns, `unique` constraints, and plain and unique indexes. A second device adopting the same data converged.
- `snapshot_required` against a real coordinator: the adopted rows reached the server, came back in the snapshot and reached another device. The handler was called directly rather than forcing a real delta floor refusal.

**Mutation checks.** Removing the snapshot wait, removing the apply drain, and sending no schema each fail the matching test below.

## Tests added

`packages/quereus-sync/test/sync/unrecorded-rows.spec.ts`:

- Records rows once; a second call finds nothing and leaves the KV store byte-identical. Idempotency.
- Announces only what a table with unrecorded rows lacks. A table with none, an empty table, an index, a table with its own create, and an alter-only history.
- Announces a table its migrations leave dropped.
- Refuses while an explicit transaction is open, and the commit chain carries on afterwards.
- Refuses while a snapshot is partly applied.
- A snapshot applied during a run waits for it and still replaces the rows.
- A remote apply under way finishes first, so its row is not stamped as local.

`packages/quereus-sync-client/test/sync-client.spec.ts`, under `'adopt'`:

- Refused with `readOnly`.
- First contact: records and pushes, no snapshot, emptiness probe skipped, one event with the count.
- Runs with `bootstrapOnEmpty` off, and not once this server has acknowledged a push.
- With nothing to adopt, an empty replica still bootstraps.
- `snapshot_required`: adoption before the first `apply_changes`, `get_snapshot` after the ack.
- A failed adoption takes no snapshot and retries through the reconnect.
- Never adopts over a pending checkpoint.
- Never adopts under a transfer an explicit `requestSnapshot()` started.

`packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts`:

- A brand-new device with no schema bootstraps the table, its index and 150 rows (more than one adoption batch), and the holder keeps its rows. This pins the schema half.

## Where this differs from the ticket

Please check these first. All are deliberate.

- **The migration rule is stricter than `getCurrentVersion === 0`.** That rule misses a table created before sync attached and altered since (only an `alter_column`), and one dropped under sync and re-created while detached (ends on `drop_table`). A receiver replaying either ends with no table, so one device's adoption would stop new devices bootstrapping, the failure the ticket exists to prevent. `hasLiveCreate` walks the object's migrations instead. Quoomb's mode switch makes both reachable.
- **The index migration type is `add_index`.** The ticket said `create_index`, which does not exist.
- **A live row with a tombstone does not beat it under the default config.** The ticket said adoption's newer HLC beats the tombstone, as a local reinsert does. By reading `TombstoneStore.isDeletedAndBlocking`, `allowResurrection` defaults to false, so a peer holding the tombstone stays deleted, whatever the HLC. It does behave as a local reinsert does, which is the part that matters, and `docs/sync.md` says this. Not run.

Added beyond the ticket, because each is wrong the moment its path runs:

- **Snapshot applies wait for adoptions under way.** The ticket's client-side check cannot cover a transfer that starts after adoption begins. Adoption's later batches would land after the header's clear, pass for the snapshot's own records, and keep rows the snapshot should delete.
- **Adoption refuses inside an explicit transaction.** The scan sees uncommitted rows, and one that then rolled back would go to every other device while this one lacks it. This meant dropping `@internal` from `_isImplicitTransaction` so `@quereus/sync` can compile against it, as `_getAllSchemas` did in the prereq. The client retries through its reconnect, so `onError` fires per attempt until the transaction ends.
- **The manager refuses a pending checkpoint too**, not only the client guard, because the result cannot be undone once pushed.
- **Applies drain before the chain entry is appended, rechecking for new ones.** Waiting from inside deadlocks, as the ticket warned, because an apply waits on the chain again before filing its metadata.

Also: `scanLiveKeys` was renamed `scanLiveColumns`, since adoption passes every column. Refactoring only.

## Edge cases checked by inspection

All as the ticket expected, except the tombstone case above.

- A local commit during adoption queues behind the entry and overwrites with a newer HLC, removing the older change-log entry.
- A broadcast during adoption waits on the chain at the start of `applyChanges`. Adoption waits on nothing that needs it once appended. One arriving during the drain waits only on the older chain tail.
- A crash mid-adoption keeps finished batches, each one KV batch, and the next connect skips them. A failed run reloads the identity index through `withIdentityRecovery`.
- A socket drop before the first ack: rows are ordinary unsent changes. The reconnect rescans and finds nothing, and the emptiness probe then materializes them, which is the condition the `NOTE` on `isReplicaEmpty` now names.
- A second server for the first time rescans and finds nothing new unless rows were written while detached.
- `opSeq`: each batch has its own tick.

## Known gaps

- **Quoomb's status bar can read "Syncing (0%)" while sync works.** The UI re-reads the worker's status only on `state-change` events, and the `changes` reply that sets `synced` emits none, so a connect with no snapshot shows the last value read. Seen on the adopting profile; sync worked in both directions regardless. It looks pre-existing and not specific to adoption, from reading the code, but no pre-change build was run. Not fixed and no ticket filed; your call whether it clears the bar.
- **Two devices adopting tables with the same name and different shapes conflict** on the existing `assertDefinitionMatches` throw, which blocks the receiver's batch until someone intervenes. Documented as a cost. Inferred from the code, not run.
- **Adoption has no end-to-end test of a real delta floor refusal**, only the mock-based client test and the throwaway above.

## Tripwires parked as `NOTE:`

- First push after adoption reads every local change into memory. `sync-client.ts`, at the adoption call site, as the ticket asked.
- The emptiness probe materializes adopted rows on a reconnect before the first `changes` reply. `sync-client.ts`, `isReplicaEmpty`.
- More than 10 columns (with default settings) makes each batch an oversized transaction, which logs a warning. `unrecorded-rows.ts`, `adoptTable`.
- The app's writes wait for each table's scan on the store module. Not measured. `unrecorded-rows.ts`, `adoptTable`.
- A table created before sync attached and renamed since still reaches receivers with no create. `unrecorded-rows.ts`, `hasLiveCreate`.
- An unbroken run of overlapping applies keeps a first attach waiting. `sync-manager-impl.ts`, `appliesDrained`.

`.release-notes.pending.md`, which is git-ignored, has the new option and the new `SyncManager` method.
