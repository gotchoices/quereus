description: Loading a full copy of the database from the server is supposed to replace what a device has, but rows the device holds that are not in the copy are left in place, so a device can never get rid of rows the server deleted long ago.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # producer table list (~127-144), table-start (~655), footer (~822), comments at ~249 and ~710 that say a fully-deleted table has no section
  - packages/quereus-sync/src/sync/snapshot.ts          # getSnapshot table list (~56-99), applySnapshot commitMetadata (~225-260)
  - packages/quereus-sync/src/sync/snapshot-identity.ts # home for shared per-table helpers; reconcileCell's map keys are the receiver's identities
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts # scanLiveRows (~216): the precedent for reading a table's live keys through ctx.db
  - packages/quereus-sync/src/metadata/table-identity.ts # needs a way to list live (name, generation) pairs
  - packages/quereus-sync/src/sync/sync-context.ts      # getTableKeyColumns, isTableInBasis, db
  - packages/quereus-sync/src/sync/manager.ts           # applySnapshot doc (~90)
  - packages/quereus-sync-client/src/sync-client.ts     # comments at requestSnapshot (~717), handleSnapshotRequired (~748), isReplicaEmpty (~864) describe the old outcome
  - docs/sync-protocol.md
  - docs/sync.md
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts # new; body below
repro: verified
----

## What is wrong

Both snapshot apply paths clear this replica's sync metadata (`cv:` cell records, `tb:` tombstones, `cl:` change log) and upsert every row the snapshot carries. Neither deletes a store row that is absent from the snapshot, although the interface promises `applySnapshot` "replaces all local data". A surviving row has no sync metadata, so it is never pushed, never removed by a later delta, and invisible to every sync path.

This is reachable in production through `snapshot_required` recovery: a client behind the server's delta floor takes a snapshot on a populated replica, and the rows it needs to lose are exactly the ones the snapshot omits. An explicit `requestSnapshot()` hits it too.

## Reproduced

Two real-engine peers (`makePeer`), spec below. Five of six cases failed on the current code, for example `expected [ 1, 2 ] to deeply equal [ 1 ]`. The sixth, which leaves an unmentioned table alone, passes and has to keep passing.

The run showed the problem is wider than the original report:

- **A table the sender emptied.** Deleting a row removes its `cv:` records and pruning removes its tombstones. The producer finds tables by scanning `cv:`, so an emptied table gets no section at all, and a fix that only reconciles tables with a section leaves every row of that table behind. The producer has to announce it.
- **A tombstoned row that has not been pruned.** It also survives today. The receiver files the tombstone and keeps the row, so metadata and data disagree. The same fix cures it, because a tombstoned row has no live cell.

## Design

**Definition of "covered".** A table is covered if the sender has a section for it. The sender emits a section for every table it has a cell for (as today) plus every table with a live `tg:` name → generation record that is in its local basis (`ctx.isTableInBasis`, which is always true on a relay with no schema oracle). The `tg:` record outlives the rows and is retired by a drop, which is what separates "emptied" from "never hosted". `TableIdentityStore` needs a small accessor listing its live names. Both producers use it (`streamSnapshotChunks`' `byName`, `getSnapshot`'s `tables`). A table the sender does not know stays unmentioned and is left alone, as `docs/sync.md` § unknown-table disposition requires. The basis check stops a stale `tg:` record (table dropped while sync was detached; see the NOTE in `TableIdentityStore.ensure`) from wiping a receiver's table.

**No wire-format bump.** No chunk shape changes; an empty section is already legal. A snapshot stored by an older build still applies and only fails to announce emptied tables. A bump would also make every stored coordinator snapshot trigger `bug-coordinator-stale-snapshot-blocks-store-open`.

**Receiver: empty sections.** The receiver must tolerate a section for a table it does not have, with no migration creating it. `table-start`/`table-end` never resolve keying, so this works if reconcile skips tables outside the basis. `bootstrapTables` may name such a table; `notifyExternalChange` only notifies watchers, so that is harmless. In `table-start`, when the table is in basis, also call `ctx.tableIdentity.ensure(schema, table, batch)`. Otherwise a replica that bootstrapped an emptied table has no `tg:` record and would not announce the table to the next peer, for example a coordinator restored from its S3 backup.

**Enumerating local rows.** Follow `rekey-on-pk-change.ts`' `scanLiveRows`: `ctx.db.eval(select <key columns> from <schema>.<table>, undefined, { readConcurrency: 'committed' })`, with key column names from `ctx.getTableKeyColumns` and identifiers quoted with `quoteIdentifier`. This needs no new adapter or store API and works with any `applyToStore` implementation. A singleton table (`primary key ()`, `docs/sql.md`) has no key columns, so select a constant and use `pk = []`. With no `ctx.db` or no key columns the pass cannot run: log a `console.warn` naming the table and carry on, as the rekey pass does. With no `ctx.applyToStore` (the relay-only coordinator) there is no row data, so skip silently.

**Removal.** Collect stale pks first and write afterwards, so nothing writes under an open scan. Send them through `applyDataToStore(ctx, deletes, [], { remote: true, bootstrap: true })` in `DATA_FLUSH_SIZE` chunks. That handles secondary indexes and stats, emits `remote: true` events so nothing is re-recorded, and leaves MV and watcher convergence to the existing `bootstrapFinalize`. A failure takes the existing error path.

**Streaming: which rows to keep.** Reconcile once, in the footer, after the last `flushDataToStore` and metadata batch write and before `bootstrapFinalize`. For each table in `completedTables` (parsed with `parseBootstrapTables`, and at that point the full covered set, including tables an earlier session completed), build the keep set by scanning `buildTableColumnVersionScanBounds(generation)` and collecting `parsed.identity`. Then scan the local table and delete each row whose `encodePkIdentity(pk, keying)` is not in the set.

This replaces the original ticket's in-memory set of received keys, because `cv:` is already that set on disk:

- `clearExistingMetadata` wiped everything except this snapshot's own earlier work, so it survives mid-table flushes and resumes with no extra state.
- A failure in the footer leaves the checkpoint in place, and the resume re-runs the footer, so the pass is retry-safe. The `resume_snapshot` requirement to reconcile re-streamed and skipped tables correctly is met without tracking which is which.
- A local write landing during the transfer has a cell record and survives. It does not widen the gap tracked in `feat-sync-bootstrap-write-gate`.
- Memory is one key per row of the table being reconciled, released between tables.

Add a `NOTE:` tripwire at the site: the pass adds one `cv:` scan and one table scan per covered table even on a brand-new replica, where it removes nothing; if bootstrap time shows it, skip it for a replica known to be empty before the header's clear. I have not measured this cost.

**Non-streaming: which rows to keep.** Keep the existing order, data first, metadata second, abort with no metadata. Inside `commitMetadata` keying is resolvable, so before `clearBatch`: build each table's `rows` map with `reconcileCell` (moved up from the rewrite loop and reused by it), use its keys as the keep set, and remove stale rows. A failure then leaves the prior metadata intact and the snapshot retries wholesale. The apply-side `bootstrapTables` already lists `snapshot.tables`, which now includes empty tables.

Both paths share one helper, for example `removeRowsAbsentFromSnapshot(ctx, schema, table, keying, keep)`, in `snapshot-identity.ts` or a small new module.

## A behaviour change to call out in the handoff

Rows the replica holds with no sync metadata in a covered table are now **deleted**, where before they were orphaned. That follows the "replaces all local data" contract and the ticket's expected behaviour, and it affects:

- Unpushed local inserts under an explicit `requestSnapshot()`. The `snapshot_required` path pushes first, so it is unaffected.
- Rows written before sync attached on a device that passes `isReplicaEmpty` (no peer state, no change facts). `bootstrapOnEmpty` now removes them if the server covers that table. Before they survived as invisible rows. Say so plainly in the `isReplicaEmpty` comment and in the docs; the review pass should judge whether that gate needs tightening.

## Reproducing spec

Create as `packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts`, then add the extra cases in the TODO list.

```ts
/**
 * A snapshot apply REPLACES what the replica holds: after it, every table the
 * snapshot covers holds exactly the snapshot's rows. A row the sender deleted and
 * pruned long ago appears nowhere in the snapshot, so only the absence can remove
 * it from a replica that fell behind.
 */

import { expect } from 'chai';
import { collect, closePeer, makePeer, relay, settle, toStream, type Peer } from './_peer-harness.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';

const ids = async (peer: Peer): Promise<number[]> =>
	(await collect(peer.db, 'select id from orders order by id')).map(r => r.id as number);

/** Delete on the sender and prune the tombstone, so no record of the row remains anywhere. */
async function deleteAndPrune(peer: Peer, where: string): Promise<void> {
	await peer.db.exec(`delete from orders where ${where}`);
	await settle();
	await peer.manager.pruneTombstones();
}

async function chunksOf(peer: Peer): Promise<SnapshotChunk[]> {
	const chunks: SnapshotChunk[] = [];
	for await (const chunk of peer.manager.getSnapshotStream()) chunks.push(chunk);
	return chunks;
}

describe('snapshot apply replaces rows absent from the snapshot', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		const config = { retentionHorizonMs: -1 };
		sender = await makePeer('sender', { createOrders: true, config });
		receiver = await makePeer('receiver', { createOrders: true, config });
		await sender.db.exec(`insert into orders values (1, 'one'), (2, 'two')`);
		await relay(sender, receiver);
		expect(await ids(receiver)).to.deep.equal([1, 2]);
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('streaming: a row deleted and pruned on the sender leaves the replica', async () => {
		await deleteAndPrune(sender, 'id = 2');
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await ids(receiver)).to.deep.equal([1]);
	});

	it('non-streaming: a row deleted and pruned on the sender leaves the replica', async () => {
		await deleteAndPrune(sender, 'id = 2');
		await receiver.manager.applySnapshot(await sender.manager.getSnapshot());
		expect(await ids(receiver)).to.deep.equal([1]);
	});

	it('streaming: a table the sender emptied and pruned is emptied here too', async () => {
		await deleteAndPrune(sender, 'id in (1, 2)');
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await ids(receiver)).to.deep.equal([]);
	});

	it('non-streaming: a table the sender emptied and pruned is emptied here too', async () => {
		await deleteAndPrune(sender, 'id in (1, 2)');
		await receiver.manager.applySnapshot(await sender.manager.getSnapshot());
		expect(await ids(receiver)).to.deep.equal([]);
	});

	it('streaming: a tombstoned (not yet pruned) row leaves the replica', async () => {
		await sender.db.exec('delete from orders where id = 2');
		await settle();
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await ids(receiver)).to.deep.equal([1]);
	});

	it('leaves a table the snapshot does not mention alone', async () => {
		await receiver.db.exec('create table local_only (id integer primary key) using store');
		await receiver.db.exec('insert into local_only values (7)');
		await settle();
		await deleteAndPrune(sender, 'id = 2');
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await collect(receiver.db, 'select id from local_only')).to.deep.equal([{ id: 7 }]);
	});
});
```

Run it alone from the repo root: `node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts --reporter spec`

## TODO

- Add the spec above and see it fail
- Add the live-names accessor to `TableIdentityStore`; emit sections for in-basis named tables with no cells from both producers, keeping the name-sorted order and correct `tableCount`/`totalTables`
- Add the shared removal helper (scan keys through `ctx.db`, collect stale pks, delete in `DATA_FLUSH_SIZE` chunks, warn when it cannot run, handle `primary key ()`)
- Streaming: call `ensure` at `table-start` for in-basis tables; reconcile `completedTables` in the footer before `bootstrapFinalize`, keep set taken from the `cv:` scan; add the tripwire `NOTE:`
- Non-streaming: move row reconciliation ahead of `clearBatch` and remove stale rows there, inside `commitMetadata`
- Add spec cases, one each: an interrupted transfer resumed after a table completed still removes that table's stale row (see `interruptedStream` in `snapshot-resume.spec.ts`); a `nocase` key spelled differently locally ('APPLE' local, 'apple' in the snapshot) is kept, not deleted, which pins that `encodePkIdentity` and the `cv:` key identity agree; a section for a table the receiver does not have applies without error
- Update comments now wrong: `snapshot-stream.ts` (~127, ~249, ~710, which say a fully-deleted table has no section; keep the flush at ~715, since older stored snapshots still lack the section), `sync-client.ts` (`requestSnapshot` contract, `handleSnapshotRequired`, `isReplicaEmpty`)
- Update docs: `docs/sync-protocol.md` (interface and chunk section: covered tables, empty sections, rows removed), `docs/sync.md` (snapshot section), `manager.ts` `applySnapshot` doc
- Run `yarn workspace @quereus/sync test` (check the package name in `packages/quereus-sync/package.json`), plus the `packages/quereus-sync-client` and `packages/sync-coordinator` tests and `yarn build`. Any existing spec that hand-builds a stream onto a populated `makePeer` receiver and expects its other rows to survive was pinning this bug: correct it and list it in the handoff. Specs that wire no `db` (`snapshot-bootstrap.spec.ts`) now log the "cannot run" warning and otherwise behave as before
