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
import { compareHLC, createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
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

/** An insert of row 1 (`note 'one'`, `qty 1`) written at `wallTime`. */
function newRowSet(wallTime: bigint): ChangeSet {
	const qty = cell(createHLC(wallTime, 0, writer, 1), 'qty', 1);
	return changeSet(qty.hlc, [cell(createHLC(wallTime, 0, writer), 'note', 'one'), qty]);
}

const asNumbers = (values: SqlValue[]): number[] => values.map(value => Number(value));

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

	// A local edit made while an apply is in flight came after the batch arrived, so it
	// wins its cells whichever clock is ahead: see docs/sync-transactions.md § Local writes
	// during an apply. `before` lands between the apply's decisions and its data write,
	// `after` between the data write and the filing.
	const windows = [
		{ row: 'a new row', existing: false, window: 'after' },
		{ row: 'an existing row', existing: true, window: 'before' },
		{ row: 'an existing row', existing: true, window: 'after' },
	] as const;
	for (const [clock, offset] of [['behind', -5_000n], ['ahead', 5_000n]] as const) {
		for (const { row, existing, window } of windows) {
			it(`a local edit of ${row} ${window} the data write wins, with the sender's clock ${clock}`, async () => {
				const { db, manager, hook } = receiver;
				if (existing) await manager.applyChanges([insertSet]);
				hook[window] = async () => { await db.exec('update orders set qty = 2 where id = 1'); };
				const sentAt = BigInt(Date.now()) + offset;
				const incoming = existing ? qtySet(sentAt, 5) : newRowSet(sentAt);
				await manager.applyChanges([incoming]);
				await settle();

				const [stored] = await collect(db, 'select note, qty from orders where id = 1');
				expect(Number(stored.qty), 'the row').to.equal(2);
				const qtyRecord = await manager.columnVersions.getColumnVersion('main', 'orders', [1], 'qty');
				expect(Number(qtyRecord?.value), 'the record').to.equal(2);
				expect(siteIdEquals(qtyRecord!.hlc.siteId, manager.getSiteId()), 'the record is this replica\'s').to.equal(true);
				expect(compareHLC(qtyRecord!.hlc, incoming.hlc), 'newer than the incoming change, so it wins on the sender too')
					.to.be.greaterThan(0);
				const pushed = (await manager.getChangesToPush(generateSiteId()))
					.flatMap(set => set.changes)
					.filter((change): change is ColumnChange => change.type === 'column' && change.column === 'qty');
				expect(asNumbers(pushed.map(change => change.value)), 'the push').to.deep.equal([2]);
				if (!existing) {
					expect(stored.note).to.equal('one');
					expect((await manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note'))?.value).to.equal('one');
				}
				expect(await manager.repairChangeLog(), 'stale change-log entries').to.equal(0);
			});
		}
	}

	it('a local delete before the data write beats an incoming edit of the row', async () => {
		const { db, manager, hook } = receiver;
		await manager.applyChanges([insertSet]);
		hook.before = async () => { await db.exec('delete from orders where id = 1'); };
		await manager.applyChanges([qtySet(BigInt(Date.now()) - 5_000n, 5)]);
		await settle();

		expect(await collect(db, 'select * from orders where id = 1')).to.deep.equal([]);
		expect(await manager.tombstones.getTombstone('main', 'orders', [1])).to.not.equal(undefined);
		expect(await manager.columnVersions.getColumnVersion('main', 'orders', [1], 'qty')).to.equal(undefined);
		expect(await manager.repairChangeLog()).to.equal(0);
	});
});
