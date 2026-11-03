description: A device that already holds data when sync is first turned on can silently lose that data the first time it connects, because the server's full copy now replaces what the device has. A person needs to decide what should happen to those rows.
architecture: docs/sync.md#snapshots-replace-rows
files:
  - packages/quereus-sync-client/src/sync-client.ts # isReplicaEmpty, the check that decides a device is new
  - packages/quereus-sync/src/sync/snapshot-coverage.ts # removeRowsAbsentFromSnapshot, which deletes the rows
  - packages/quereus-sync/src/sync/manager.ts # where a new row check or adoption entry point would go
  - packages/quoomb-web/src/worker/quereus.worker.ts # setStorageModule: "store" then "sync" reaches this
  - docs/sync.md
  - docs/sync-protocol.md
repro: static
----

**Blocked: the specification is silent. It unblocks when someone accepts or edits the proposed rule below:** *rows written before sync attached must not be deleted by an automatic snapshot.*

## Background

Sync keeps a record of each cell it knows about. Rows written before sync was attached to a database have no such record, so no sync path can see them: they are never pushed and never receive updates.

Loading a full copy of the database from the server (a snapshot) used to leave those rows alone. Since `ticket(implement): bug-sync-snapshot-apply-keeps-rows-absent-from-snapshot`, a snapshot makes each table it covers hold exactly the server's rows, because that is the only way a device that fell behind can lose rows the server deleted long ago. A row with no sync record looks the same as one of those stale rows, so it is deleted as well.

## How a device reaches this

- **First connect (automatic, on by default).** `bootstrapOnEmpty` treats a device as new when it has no history with this server and no recorded changes. A device with only pre-attach rows passes both tests. The snapshot then deletes those rows from every table the server also has.
- **Quoomb Web.** Working in `setStorageModule("store")` mode and then switching to `"sync"` and connecting is this path. I read this in the code and did not run it in a browser.
- **`snapshot_required` recovery.** When a server has pruned its deletion history, a device behind that point must take a snapshot. Its "push first" step cannot protect these rows, since they have nothing to push.

Before the change, these rows survived but silently diverged from every other device. Now they are lost with no error and nothing in the logs. `docs/sync.md` and the `isReplicaEmpty` comment describe the behaviour, but an app user would never see that.

## Proposed rule

Add to `docs/sync.md` § Snapshots replace rows:

> A snapshot started automatically must not delete rows that sync has never recorded. Before the first exchange with a server, a replica adopts any rows it holds into sync by recording them as local changes, so they are pushed and merged like any other offline work. A replica that holds rows is not empty.

Adoption is the recommended default because it is the only option that keeps the data and also ends the divergence. It is also the most work: it needs a scan of each table on first attach, and it changes what the server receives. If two devices hold different rows under the same key, the usual last-writer-wins merge settles them, instead of a blanket delete.

## Alternatives

- **Tighten `isReplicaEmpty` only**, so a device holding rows is not treated as new. This is small and has a cheap failure mode: a false positive just falls back to an ordinary delta sync. But it only moves the problem, since `snapshot_required` still deletes the rows once the server has any pruning history, and the rows stay invisible until then. It is a reasonable first step, but not a full answer. I did not add it in review for that reason, and because it adds a public method to `SyncManager`.
- **Refuse and report.** Stop the bootstrap with an error naming the tables that hold unrecorded rows, and let the app choose. This is honest and simple, but every app then needs a recovery flow, and `snapshot_required` recovery would be stuck until one exists.
- **Document that attaching sync to a populated database is unsupported.** This is the cheapest, but it leaves a silent delete on a path this repo's own web app offers.

## If nothing is done

Default settings delete user data, with no error, on the first connect of a device that held data before sync was attached. The deletion cannot be reversed from within sync, because the rows have no record anywhere else.

## How reversible is this choice

Adoption changes what devices send to servers, and adopted rows then reach other devices, so that part is hard to undo once shipped. The tighter check and the refusal can be changed later without any stored-data consequences.

## Decision (2026-11-02, from the maintainer)

Unblocked. What happens to these rows becomes a client option, and the default never deletes them. This settles the specification question above and replaces the "Proposed rule" and "Alternatives" sections; adoption is no longer the default.

Add one option to the sync client (`packages/quereus-sync-client/src/types.ts`, beside `bootstrapOnEmpty`), working name `unrecordedRows`:

| Value | What happens to rows sync has never recorded |
|---|---|
| `'refuse'` (**default**) | An automatic snapshot stops before deleting anything. The error names the affected tables and this option. |
| `'adopt'` | The rows are recorded as local changes on first attach, then pushed and merged by last-writer-wins. Scans each table once. |
| `'replace'` | The snapshot deletes them, which is today's behaviour, now only when the app asks. |

Rules that go with it:

- **`snapshot_required` recovery follows the same option.** Under `'refuse'`, a device that fell behind stops with that error until the app chooses.
- **An explicit `requestSnapshot` stays a full replace**, because the caller asked for it. It is already documented that way.
- **Quoomb Web sets `'adopt'`**, since someone switching from "store" to "sync" almost certainly wants to keep their data.
- **`'refuse'` must not break the common path.** A device with no unrecorded rows bootstraps exactly as it does now, and the check must not delete or write anything.

Update `docs/sync.md` § Snapshots replace rows, `docs/sync-protocol.md`, the client README, and the `bootstrapOnEmpty` doc that currently warns about this loss.

Size this for the release going out once it lands. Split `prereq:`-chained implement tickets if `'adopt'` warrants its own run.
