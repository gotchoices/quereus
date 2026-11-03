/**
 * Finding rows sync has never recorded, which a snapshot covering their table would
 * delete. See docs/sync.md § Rows sync has never recorded.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { InMemoryKVStore, StoreEventEmitter, StoreModule, type KVStore } from '@quereus/store';
import { collect, closePeer, createInMemoryProvider, localWrite, makePeer, relay, settle, toStream, type Peer } from './_peer-harness.js';
import { createSyncModule } from '../../src/create-sync-module.js';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';

async function dump(kv: KVStore): Promise<Array<[string, string]>> {
	const entries: Array<[string, string]> = [];
	for await (const { key, value } of kv.iterate()) {
		entries.push([Buffer.from(key).toString('hex'), Buffer.from(value).toString('hex')]);
	}
	return entries;
}

async function chunksOf(peer: Peer): Promise<SnapshotChunk[]> {
	const chunks: SnapshotChunk[] = [];
	for await (const chunk of peer.manager.getSnapshotStream()) chunks.push(chunk);
	return chunks;
}

/** Hold every sync-metadata batch write until the returned function runs. */
function holdBatchWrites(kv: KVStore): () => void {
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const newBatch = kv.batch.bind(kv);
	kv.batch = () => {
		const batch = newBatch();
		const write = batch.write.bind(batch);
		batch.write = async () => { await held; await write(); };
		return batch;
	};
	return release;
}

/** With row 1 of `orders` written but its records held back, the check must wait rather than report it. */
async function expectHeldRowNotReported(peer: Peer, release: () => void): Promise<void> {
	expect(await collect(peer.db, 'select id from orders')).to.deep.equal([{ id: 1 }]);
	expect((await peer.manager.columnVersions.getRowVersions('main', 'orders', [1])).size, 'the row has no records yet').to.equal(0);

	const checking = peer.manager.findTablesWithUnrecordedRows();
	await settle();
	release();

	expect(await checking).to.deep.equal([]);
}

describe('findTablesWithUnrecordedRows', () => {
	it('names only a table whose rows predate sync, and writes nothing', async () => {
		const { provider } = createInMemoryProvider();
		const events = new StoreEventEmitter();
		const db = new Database();
		const storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		await db.exec('create table before_sync (id integer primary key, v text) using store');
		await db.exec(`insert into before_sync values (1, 'a')`);
		await db.exec('create table scratch (id integer primary key) using memory');
		await db.exec('insert into scratch values (1)');

		const kv = new InMemoryKVStore();
		const { syncManager } = await createSyncModule(kv, {
			transactionSource: db,
			applyToStore: createStoreAdapter({ db, storeModule, events }),
			getTableSchema: (schema, table) => db.schemaManager.getTable(schema, table),
			keyNormalizerResolver: db.getKeyNormalizerResolver(),
		});

		await db.exec('create table after_sync (id integer primary key, v text) using store');
		await db.exec(`insert into after_sync values (1, 'b')`);
		await db.exec('create materialized view summary using store as select v, count(*) as c from after_sync group by v');
		expect(await collect(db, 'select v, c from summary')).to.deep.equal([{ v: 'b', c: 1 }]);
		await settle();

		const before = await dump(kv);
		expect(await syncManager.findTablesWithUnrecordedRows()).to.deep.equal([{ schema: 'main', table: 'before_sync' }]);
		expect(await dump(kv), 'the check must not write').to.deep.equal(before);

		await db.close();
		await provider.closeAll();
	});

	describe('rows that only look unrecorded for a moment', () => {
		let sender: Peer;
		let receiver: Peer;

		beforeEach(async () => {
			sender = await makePeer('sender', { createOrders: true });
			receiver = await makePeer('receiver', { createOrders: true });
		});

		afterEach(async () => {
			await closePeer(sender);
			await closePeer(receiver);
		});

		it('does not report a row whose local commit is still being recorded', async () => {
			const release = holdBatchWrites(receiver.manager.kv);
			await receiver.db.exec(`insert into orders values (1, 'one')`);
			await expectHeldRowNotReported(receiver, release);
		});

		it('does not report a row a remote apply has written but not yet recorded', async () => {
			await localWrite(sender, `insert into orders values (1, 'one')`);
			const changes = await sender.manager.getChangesSince(receiver.manager.getSiteId());

			const release = holdBatchWrites(receiver.manager.kv);
			const applying = receiver.manager.applyChanges(changes);
			await settle();
			await expectHeldRowNotReported(receiver, release);
			await applying;
		});

		it('does not report a row committed after the check began, while an earlier table was being scanned', async () => {
			await receiver.db.exec('create table later (id integer primary key) using store');
			await localWrite(receiver, `insert into orders values (1, 'one')`);

			// Fired from inside the scan of `orders`, which holds the execution mutex, so the
			// insert lands as that scan closes and ahead of the scan of `later`.
			const versions = receiver.manager.columnVersions;
			const readVersions = versions.getRowVersions.bind(versions);
			let release: (() => void) | undefined;
			let inserting: Promise<void> | undefined;
			versions.getRowVersions = async (schema, table, pk) => {
				if (!inserting) {
					release = holdBatchWrites(receiver.manager.kv);
					inserting = receiver.db.exec('insert into later values (1)');
				}
				return readVersions(schema, table, pk);
			};

			const checking = receiver.manager.findTablesWithUnrecordedRows();
			await settle();
			release!();

			expect(await checking).to.deep.equal([]);
			await inserting;
		});
	});

	it('a crash as a snapshot header clears the metadata leaves a checkpoint, and the resume finishes', async () => {
		const sender = await makePeer('sender', { createOrders: true });
		const receiver = await makePeer('receiver', { createOrders: true });
		await sender.db.exec(`insert into orders values (1, 'one')`);
		await relay(sender, receiver);

		const kv = receiver.manager.kv;
		const newBatch = kv.batch.bind(kv);
		kv.batch = () => {
			const batch = newBatch();
			batch.write = async () => { throw new Error('simulated crash'); };
			return batch;
		};
		let thrown: unknown;
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender))).catch((error: unknown) => { thrown = error; });
		kv.batch = newBatch;
		expect(thrown).to.be.instanceOf(Error);

		const [checkpoint] = await receiver.manager.listSnapshotCheckpoints();
		expect(checkpoint, 'without a checkpoint a client would scan and could see every row as unrecorded').to.not.equal(undefined);

		await receiver.manager.applySnapshotStream(sender.manager.resumeSnapshotStream(checkpoint));
		expect(await receiver.manager.listSnapshotCheckpoints()).to.deep.equal([]);
		expect(await receiver.manager.findTablesWithUnrecordedRows()).to.deep.equal([]);

		await closePeer(sender);
		await closePeer(receiver);
	});
});
