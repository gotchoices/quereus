/**
 * Work that reaches one replica while an apply is in flight. An apply decides each cell
 * against its stored record and files that decision last, so nothing may file over that
 * record in between: see docs/sync-transactions.md § Filing position.
 */

import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import { InMemoryKVStore, StoreEventEmitter, StoreModule } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { DEFAULT_SYNC_CONFIG, type ApplyToStoreCallback, type ChangeSet, type ColumnChange } from '../../src/sync/protocol.js';
import { collect, createInMemoryProvider, settle } from './_peer-harness.js';

/** Each runs once, around the next call into the real store adapter, then clears itself. */
interface StoreHook {
	before?: () => Promise<void>;
	after?: () => Promise<void>;
}

interface Receiver {
	readonly db: Database;
	readonly manager: SyncManagerImpl;
	readonly hook: StoreHook;
}

async function makeReceiver(): Promise<Receiver> {
	const hook: StoreHook = {};
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const real = createStoreAdapter({ db, storeModule, events });
	const applyToStore: ApplyToStoreCallback = async (data, schema, options) => {
		const before = hook.before;
		hook.before = undefined;
		if (before) await before();
		const result = await real(data, schema, options);
		const after = hook.after;
		hook.after = undefined;
		if (after) await after();
		return result;
	};
	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(), db, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
		(s, t) => db.schemaManager.getTable(s, t), undefined, db.getKeyNormalizerResolver(),
	);
	await db.exec('create table orders (id integer primary key, note text, qty integer) using store');
	await settle();
	return { db, manager, hook };
}

/** A promise the test resolves by hand, to hold an apply at a chosen point. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>(resolve => { open = resolve; });
	return { opened, open };
}

const writer = generateSiteId();
const now = BigInt(Date.now());

const cell = (hlc: HLC, column: string, value: SqlValue, prior?: ColumnChange): ColumnChange => ({
	type: 'column', schema: 'main', table: 'orders', pk: [1], column, value, hlc,
	...(prior ? { priorHlc: prior.hlc, priorValue: prior.value } : {}),
});

const changeSet = (hlc: HLC, changes: ColumnChange[]): ChangeSet =>
	({ siteId: writer, transactionId: `tx-${hlc.wallTime}`, hlc, changes, schemaMigrations: [] });

const insertedAt = createHLC(now - 20_000n, 0, writer);
const insertedQty = cell(createHLC(insertedAt.wallTime, 0, writer, 1), 'qty', 1);
const insertSet = changeSet(insertedQty.hlc, [cell(insertedAt, 'note', 'one'), insertedQty]);

/** An edit of row 1's `qty` written at `wallTime`, by a writer that had seen the insert. */
function qtySet(wallTime: bigint, qty: number): ChangeSet {
	const hlc = createHLC(wallTime, 0, writer);
	return changeSet(hlc, [cell(hlc, 'qty', qty, insertedQty)]);
}

describe('applies on one replica', () => {
	let receiver: Receiver;

	beforeEach(async () => { receiver = await makeReceiver(); });
	afterEach(async () => { await receiver.db.close(); });

	it('a newer apply started during an older one ends with the newer value in the row and the record', async () => {
		const { db, manager, hook } = receiver;
		const rowQty = async (): Promise<number[]> =>
			(await collect(db, 'select qty from orders where id = 1')).map(row => Number(row.qty));
		await manager.applyChanges([insertSet]);
		const reached = gate();
		const released = gate();
		hook.after = async () => { reached.open(); await released.opened; };

		// The older apply is held after its data write; the newer one cannot start until it
		// finishes, so it must not be awaited before the release.
		const older = manager.applyChanges([qtySet(now - 10_000n, 5)]);
		await reached.opened;
		const newer = manager.applyChanges([qtySet(now - 5_000n, 7)]);
		await settle();
		expect(await rowQty(), 'the newer apply wrote while the older one was in flight').to.deep.equal([5]);
		released.open();
		await Promise.all([older, newer]);

		expect(await rowQty()).to.deep.equal([7]);
		expect((await manager.columnVersions.getColumnVersion('main', 'orders', [1], 'qty'))?.value).to.equal(7);
		expect(await manager.repairChangeLog()).to.equal(0);
	});
});
