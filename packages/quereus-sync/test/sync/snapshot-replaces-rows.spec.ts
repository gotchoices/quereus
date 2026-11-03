/**
 * A snapshot apply REPLACES what the replica holds: after it, every table the
 * snapshot covers holds exactly the snapshot's rows. A row the sender deleted and
 * pruned long ago appears nowhere in the snapshot, so only the absence can remove
 * it from a replica that fell behind.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { collect, closePeer, localWrite, makePeer, relay, settle, toStream, type Peer } from './_peer-harness.js';
import { createSyncModule } from '../../src/create-sync-module.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';

/** Above this many cells a stream saves a resume checkpoint mid-table (`BATCH_FLUSH_SIZE`, two cells per row). */
const ROWS_TO_FORCE_A_CHECKPOINT = 500;

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

/** Replay `chunks` up to the footer, then fail: a connection dropped mid-transfer. */
async function* droppedBeforeFooter(chunks: SnapshotChunk[]): AsyncIterable<SnapshotChunk> {
	for (const chunk of chunks) {
		if (chunk.type === 'footer') throw new Error('simulated connection drop');
		yield chunk;
	}
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

	it('leaves a materialized view to the finalize refresh, since its rows never travel and it may have no write path', async () => {
		const createView = 'create materialized view by_note using memory as select note, count(*) as c from orders group by note';
		await sender.db.exec(createView);
		await receiver.db.exec(createView);
		await deleteAndPrune(sender, 'id = 2');

		const chunks = await chunksOf(sender);
		expect(chunks.some(chunk => chunk.type === 'table-start' && chunk.table === 'by_note')).to.equal(true);
		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(await collect(receiver.db, 'select note, c from by_note')).to.deep.equal([{ note: 'one', c: 1 }]);
	});

	it('a transfer resumed after a table completed still removes that table\'s absent row', async () => {
		await deleteAndPrune(sender, 'id = 2');
		await sender.db.exec('create table trailer (id integer primary key, v text) using store');
		const values = Array.from({ length: ROWS_TO_FORCE_A_CHECKPOINT }, (_, i) => `(${i}, 'v')`).join(', ');
		await localWrite(sender, `insert into trailer values ${values}`);

		const dropped = droppedBeforeFooter(await chunksOf(sender));
		let thrown: unknown;
		await receiver.manager.applySnapshotStream(dropped).catch((error: unknown) => { thrown = error; });
		expect(thrown).to.be.instanceOf(Error);

		const [checkpoint] = await receiver.manager.listSnapshotCheckpoints();
		expect(checkpoint.completedTables).to.include('main.orders');
		expect(await ids(receiver), 'the removal waits for the footer').to.deep.equal([1, 2]);

		await receiver.manager.applySnapshotStream(sender.manager.resumeSnapshotStream(checkpoint));
		expect(await ids(receiver)).to.deep.equal([1]);
	});

	it('keeps a row whose key is spelled differently here, under a key collation', async () => {
		const ddl = 'create table fruit (k text collate nocase primary key, v text) using store';
		await sender.db.exec(ddl);
		await receiver.db.exec(ddl);
		await receiver.db.exec(`insert into fruit values ('APPLE', 'local'), ('banana', 'local')`);
		// The apply also writes the key cell, so the removal pass reads the sender's
		// spelling back: only 'BANANA' tells a collated comparison from a raw one.
		await localWrite(sender, `insert into fruit values ('apple', 'sender'), ('BANANA', 'sender')`);

		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		expect(await collect(receiver.db, 'select v from fruit')).to.deep.equal([{ v: 'sender' }, { v: 'sender' }]);
	});

	it('keeps a row of every key type, whose scanned key must encode to the identity its cells were filed under', async () => {
		const keys: Array<[column: string, value: string]> = [
			['k integer primary key', '9007199254740993'],
			['k real primary key', '2.0'],
			['k blob primary key', `x'00ff10'`],
			['k boolean primary key', 'true'],
			['k date primary key', `'2024-01-15'`],
			['k datetime primary key', `'2024-01-15T10:20:30'`],
			['k timespan primary key', `'PT1H'`],
			['k json primary key', `'{"a":1}'`],
		];
		for (const [i, [column, value]] of keys.entries()) {
			const ddl = `create table t${i} (${column}, v text) using store`;
			await sender.db.exec(ddl);
			await receiver.db.exec(ddl);
			await sender.db.exec(`insert into t${i} values (${value}, 'kept')`);
		}
		await settle();

		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		for (const [i, [column]] of keys.entries()) {
			expect(await collect(receiver.db, `select v from t${i}`), column).to.deep.equal([{ v: 'kept' }]);
		}
	});

	it('keeps or removes the one row of a singleton table, whose key has no columns', async () => {
		const ddl = 'create table settings (v integer, primary key ()) using store';
		await sender.db.exec(ddl);
		await receiver.db.exec(ddl);
		await receiver.db.exec('insert into settings values (1)');
		await localWrite(sender, 'insert into settings values (2)');

		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await collect(receiver.db, 'select v from settings')).to.deep.equal([{ v: 2 }]);

		await localWrite(sender, 'delete from settings');
		await sender.manager.pruneTombstones();
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));
		expect(await collect(receiver.db, 'select v from settings')).to.deep.equal([]);
	});

	describe('a section for a table this replica does not have, with no migration creating it', () => {
		const isGhostMigration = (chunk: SnapshotChunk): boolean =>
			chunk.type === 'schema-migration' && chunk.migration.table === 'ghost';

		beforeEach(async () => {
			await sender.db.exec('create table ghost (id integer primary key) using store');
			await settle();
		});

		it('streaming: applies without error', async () => {
			const chunks = (await chunksOf(sender)).filter(chunk => !isGhostMigration(chunk));
			expect(chunks.some(chunk => chunk.type === 'table-start' && chunk.table === 'ghost')).to.equal(true);

			await receiver.manager.applySnapshotStream(toStream(chunks));

			expect(receiver.db.schemaManager.getTable('main', 'ghost')).to.equal(undefined);
			expect(await ids(receiver)).to.deep.equal([1, 2]);
		});

		it('non-streaming: applies without error', async () => {
			const snapshot = await sender.manager.getSnapshot();
			expect(snapshot.tables.map(t => t.table)).to.include('ghost');

			await receiver.manager.applySnapshot({
				...snapshot,
				schemaMigrations: snapshot.schemaMigrations.filter(m => m.table !== 'ghost'),
			});

			expect(receiver.db.schemaManager.getTable('main', 'ghost')).to.equal(undefined);
			expect(await ids(receiver)).to.deep.equal([1, 2]);
		});
	});

	it('streaming: a relay that bootstrapped an emptied table announces it to the next peer', async () => {
		await deleteAndPrune(sender, 'id in (1, 2)');
		const noMigrations = (await chunksOf(sender)).filter(chunk => chunk.type !== 'schema-migration');

		const { syncManager: relayManager } = await createSyncModule(new InMemoryKVStore());
		await relayManager.applySnapshotStream(toStream(noMigrations));

		const announced: string[] = [];
		for await (const chunk of relayManager.getSnapshotStream()) {
			if (chunk.type === 'table-start') announced.push(chunk.table);
		}
		expect(announced).to.deep.equal(['orders']);
	});

	it('non-streaming: a relay that bootstrapped an emptied table announces it to the next peer', async () => {
		await deleteAndPrune(sender, 'id in (1, 2)');
		const snapshot = await sender.manager.getSnapshot();

		const { syncManager: relayManager } = await createSyncModule(new InMemoryKVStore());
		await relayManager.applySnapshot({ ...snapshot, schemaMigrations: [] });

		expect((await relayManager.getSnapshot()).tables.map(t => t.table)).to.deep.equal(['orders']);
	});
});
