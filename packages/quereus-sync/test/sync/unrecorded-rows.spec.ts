/**
 * Finding rows sync has never recorded, which a snapshot covering their table would
 * delete. See docs/sync.md § Rows sync has never recorded.
 */

import { expect } from 'chai';
import { Database, MemoryTableModule, type SqlValue } from '@quereus/quereus';
import { InMemoryKVStore, StoreEventEmitter, StoreModule, type KVStore } from '@quereus/store';
import { changesFor, collect, closePeer, createInMemoryProvider, localWrite, makePeer, relay, relayAll, settle, toStream, type Peer } from './_peer-harness.js';
import { createSyncModule } from '../../src/create-sync-module.js';
import type { HLC } from '../../src/clock/hlc.js';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import type { SnapshotChunk } from '../../src/sync/protocol.js';
import { DATA_FLUSH_SIZE } from '../../src/sync/snapshot-coverage.js';
import { saveSnapshotCheckpoint } from '../../src/sync/snapshot-checkpoint.js';
import { generateSiteId } from '../../src/clock/site.js';

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
			const readVersions = versions.hasRowVersions.bind(versions);
			let release: (() => void) | undefined;
			let inserting: Promise<void> | undefined;
			versions.hasRowVersions = async (schema, table, pk) => {
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

describe('editing a row', () => {
	const ORDERS = 'create table orders (id integer primary key, note text, qty integer) using store';
	let peer: Peer;

	afterEach(async () => {
		await closePeer(peer);
	});

	it('records the whole row on the first edit of an unrecorded one, so a receiver gets no fragment', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (9, 'nine', 9)` });
		const receiver = await makePeer('b', { createOrders: true, ordersDdl: ORDERS });

		await localWrite(peer, `update orders set note = 'nine2' where id = 9`);

		const changes = await changesFor(peer, receiver.manager.getSiteId());
		expect(changes.map(change => change.type === 'column' && change.column).sort()).to.deep.equal(['id', 'note', 'qty']);
		expect(changes.filter(change => change.type === 'column' && change.priorHlc !== undefined)).to.deep.equal([]);

		await relay(peer, receiver);
		expect(await collect(receiver.db, 'select id, note, qty from orders')).to.deep.equal([{ id: 9, note: 'nine2', qty: 9 }]);
		await closePeer(receiver);
	});

	it('leaves an unrecorded row unrecorded when an update changes nothing', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (9, 'nine', 9)` });

		await localWrite(peer, 'update orders set note = note where id = 9');

		expect(await peer.manager.getChangesSince(generateSiteId())).to.deep.equal([]);
		expect(await peer.manager.findTablesWithUnrecordedRows()).to.deep.equal([{ schema: 'main', table: 'orders' }]);
	});

	describe('a recorded row, first writing a column added since', () => {
		beforeEach(async () => {
			peer = await makePeer('a', { createOrders: true, ordersDdl: ORDERS });
			await localWrite(peer, `insert into orders values (1, 'one', 1)`);
			await localWrite(peer, 'alter table orders add column extra text null');
		});

		async function qtyHlc(pk: SqlValue[]): Promise<HLC | undefined> {
			return (await peer.manager.columnVersions.getColumnVersion('main', 'orders', pk, 'qty'))?.hlc;
		}

		it('records only that cell', async () => {
			const before = await qtyHlc([1]);

			await localWrite(peer, `update orders set extra = 'x' where id = 1`);

			expect(await qtyHlc([1])).to.deep.equal(before);
			expect((await peer.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'extra'))?.value).to.equal('x');
		});

		it('records only that cell when the same transaction re-keys the table, whose records it has only staged', async () => {
			const before = await qtyHlc([1]);

			await peer.db.exec('begin');
			await peer.db.exec('alter table orders alter primary key (id, note)');
			await peer.db.exec(`update orders set extra = 'x' where id = 1`);
			await peer.db.exec('commit');
			await settle();

			expect(await qtyHlc([1, 'one'])).to.deep.equal(before);
			expect((await peer.manager.columnVersions.getColumnVersion('main', 'orders', [1, 'one'], 'extra'))?.value).to.equal('x');
		});
	});
});

describe('adoptUnrecordedRows', () => {
	const ORDERS = 'create table orders (id integer primary key, note text) using store';
	let peer: Peer | undefined;

	afterEach(async () => {
		if (peer) await closePeer(peer);
		peer = undefined;
	});

	/** Every migration a peer's first push would carry, as `type object`. */
	async function migrationsOf(from: Peer): Promise<string[]> {
		const sets = await from.manager.getChangesSince(generateSiteId());
		return sets.flatMap(set => set.schemaMigrations.map(m => `${m.type} ${m.table}`));
	}

	async function adoptionFailure(from: Peer): Promise<unknown> {
		return from.manager.adoptUnrecordedRows().then(() => undefined, (error: unknown) => error);
	}

	it('records rows once, and a second call finds nothing and writes nothing', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (1, 'one'), (2, 'two')` });

		expect(await peer.manager.adoptUnrecordedRows()).to.deep.equal({ tables: [{ schema: 'main', table: 'orders' }], rows: 2 });
		expect(await peer.manager.findTablesWithUnrecordedRows()).to.deep.equal([]);

		const before = await dump(peer.manager.kv);
		expect(await peer.manager.adoptUnrecordedRows()).to.deep.equal({ tables: [], rows: 0 });
		expect(await dump(peer.manager.kv)).to.deep.equal(before);
	});

	it('announces only what a table with unrecorded rows lacks', async () => {
		peer = await makePeer('a', {
			beforeSync: `${ORDERS}; create index orders_note on orders (note); insert into orders values (1, 'one');
				create table empty_one (id integer primary key) using store;
				create table altered (id integer primary key) using store; insert into altered values (1)`,
		});
		await peer.db.exec('create table announced (id integer primary key) using store');
		await localWrite(peer, `alter table altered add column note text default 'none'`);

		await peer.manager.adoptUnrecordedRows();

		expect((await migrationsOf(peer)).sort()).to.deep.equal([
			'add_index orders_note',
			'alter_column altered',
			'create_table altered',
			'create_table announced',
			'create_table orders',
		]);
	});

	it('announces a table its migrations leave dropped', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (1, 'one')` });
		const migrations = peer.manager.schemaMigrations;
		const stored = { ddl: ORDERS, hlc: peer.manager.getCurrentHLC() };
		await migrations.recordMigration('main', 'table', 'orders', { ...stored, type: 'create_table', schemaVersion: 1 });
		await migrations.recordMigration('main', 'table', 'orders', { ...stored, type: 'drop_table', schemaVersion: 2 });

		await peer.manager.adoptUnrecordedRows();

		const types: string[] = [];
		for await (const { type } of migrations.getAllMigrations('main', 'table', 'orders')) types.push(type);
		expect(types).to.deep.equal(['create_table', 'drop_table', 'create_table']);
	});

	it('announces an index again after a table it announces late, or a receiver ends up without it', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (1, 'one')` });
		await localWrite(peer, 'create index orders_note on orders (note)');
		await peer.manager.adoptUnrecordedRows();

		const delta = await makePeer('delta');
		await relayAll(peer, delta);
		const snapshot = await makePeer('snapshot');
		await snapshot.manager.applySnapshotStream(toStream(await chunksOf(peer)));

		for (const receiver of [delta, snapshot]) {
			expect(await collect(receiver.db, 'select id from orders')).to.deep.equal([{ id: 1 }]);
			expect(receiver.db.schemaManager.getTable('main', 'orders')?.indexes?.map(index => index.name)).to.deep.equal(['orders_note']);
			await closePeer(receiver);
		}
	});

	it('leaves a table no receiver could write, whose rows would fail the receiver batch', async () => {
		peer = await makePeer('a', {
			beforeSync: async db => {
				db.registerModule('plugin', new MemoryTableModule());
				await db.exec(`create table p (id integer primary key) using plugin; insert into p values (1)`);
			},
		});

		expect(await peer.manager.adoptUnrecordedRows()).to.deep.equal({ tables: [], rows: 0 });
		expect(await peer.manager.getChangesSince(generateSiteId())).to.deep.equal([]);
	});

	it('refuses while an explicit transaction is open, and the commit chain carries on', async () => {
		peer = await makePeer('a', { beforeSync: ORDERS });
		await peer.db.exec('begin');
		await peer.db.exec(`insert into orders values (1, 'may roll back')`);

		const failure = await adoptionFailure(peer);
		await peer.db.exec('rollback');

		expect(failure).to.be.instanceOf(Error);
		expect((failure as Error).message).to.include('transaction');
		expect(await peer.manager.getChangesSince(generateSiteId())).to.deep.equal([]);

		await localWrite(peer, `insert into orders values (2, 'two')`);
		expect((await peer.manager.columnVersions.getRowVersions('main', 'orders', [2])).size).to.equal(2);
	});

	it('refuses while a snapshot is partly applied, when every row would look unrecorded', async () => {
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values (1, 'one')` });
		await saveSnapshotCheckpoint(peer.manager, {
			snapshotId: 'snap', siteId: peer.manager.getSiteId(), hlc: peer.manager.getCurrentHLC(),
			lastTableIndex: 0, lastEntryIndex: 0, completedTables: [], entriesProcessed: 0, createdAt: 1,
		});

		expect(await adoptionFailure(peer)).to.be.instanceOf(Error);
		expect(await peer.manager.getChangesSince(generateSiteId())).to.deep.equal([]);
	});

	it('a snapshot applied during a run waits for it, and still replaces the rows', async () => {
		const sender = await makePeer('sender', { createOrders: true });
		await localWrite(sender, `insert into orders values (1, 'one')`);
		const chunks = await chunksOf(sender);
		// More than one batch: a batch written after the snapshot's clear would pass for
		// the snapshot's own records, and its rows would survive the replace.
		const local = Array.from({ length: DATA_FLUSH_SIZE + 1 }, (_, i) => `(${i + 2}, 'local')`).join(', ');
		peer = await makePeer('a', { beforeSync: `${ORDERS}; insert into orders values ${local}` });

		const release = holdBatchWrites(peer.manager.kv);
		const adopting = peer.manager.adoptUnrecordedRows();
		await settle();
		const applying = peer.manager.applySnapshotStream(toStream(chunks));
		await settle();
		release();
		await adopting;
		await applying;

		expect(await collect(peer.db, 'select id from orders')).to.deep.equal([{ id: 1 }]);
		await closePeer(sender);
	});

	it('a remote apply under way finishes first, so its row is not stamped as local', async () => {
		const sender = await makePeer('sender', { createOrders: true });
		peer = await makePeer('a', { createOrders: true });
		await localWrite(sender, `insert into orders values (1, 'remote')`);
		const changes = await sender.manager.getChangesSince(peer.manager.getSiteId());

		const release = holdBatchWrites(peer.manager.kv);
		const applying = peer.manager.applyChanges(changes);
		await settle();
		const adopting = peer.manager.adoptUnrecordedRows();
		await settle();
		release();
		await applying;

		expect((await adopting).rows).to.equal(0);
		await closePeer(sender);
	});
});
