/**
 * What a replica pushes upstream: what it wrote, however much it has received.
 * See docs/sync.md § Read side → Pushing upstream.
 */

import { expect } from 'chai';
import { closePeer, COLUMNS_PER_FRESH_INSERT, DEFAULT_ORDERS_DDL, localWrite, makePeer, type Peer } from './_peer-harness.js';
import { createHLC, deterministicTxnId, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import type { ChangeSet } from '../../src/sync/protocol.js';

describe('getChangesToPush', () => {
	const server = generateSiteId();
	const otherDevice = generateSiteId();
	let peer: Peer;
	let counter = 0;

	const nextForeignHLC = (): HLC => createHLC(BigInt(Date.now()), ++counter, otherDevice, 0);

	function foreignChangeSet(hlc: HLC, content: Pick<ChangeSet, 'changes' | 'schemaMigrations'>): ChangeSet {
		return { siteId: otherDevice, transactionId: deterministicTxnId(hlc), hlc, ...content };
	}

	async function receiveForeignRow(id: number): Promise<HLC> {
		const hlc = nextForeignHLC();
		await peer.manager.applyChanges([foreignChangeSet(hlc, {
			changes: [{ type: 'column', schema: 'main', table: 'orders', pk: [id], column: 'note', value: 'theirs', hlc }],
			schemaMigrations: [],
		})]);
		return hlc;
	}

	async function receiveForeignTable(table: string): Promise<void> {
		const hlc = nextForeignHLC();
		await peer.manager.applyChanges([foreignChangeSet(hlc, {
			changes: [],
			schemaMigrations: [{
				type: 'create_table',
				schema: 'main',
				table,
				ddl: `create table ${table} (id integer primary key) using store`,
				hlc,
				schemaVersion: 1,
			}],
		})]);
	}

	/** Read one batch at a time from `since`, as a client's push loop does, until a read comes back empty. */
	async function drain(since: HLC | undefined): Promise<ChangeSet[][]> {
		const MAX_READS = 10;
		const batches: ChangeSet[][] = [];
		let watermark = since;
		for (let read = 0; read < MAX_READS; read++) {
			const batch = await peer.manager.getChangesToPush(server, watermark);
			if (batch.length === 0) return batches;
			batches.push(batch);
			watermark = batch[batch.length - 1].hlc;
		}
		throw new Error(`still reading after ${MAX_READS} batches: the watermark is not advancing`);
	}

	beforeEach(async () => {
		// One own insert fills a batch exactly, so each read should carry one transaction.
		peer = await makePeer('device', {
			beforeSync: DEFAULT_ORDERS_DDL,
			config: { batchSize: COLUMNS_PER_FRESH_INSERT },
		});
	});

	afterEach(async () => {
		await closePeer(peer);
	});

	it("drains only its own work, a batch at a time, past runs of other devices' transactions", async () => {
		await receiveForeignTable('their_table');
		const firstForeignRow = await receiveForeignRow(10);
		await receiveForeignRow(11);
		await localWrite(peer, 'create table our_table (id integer primary key) using store');
		await localWrite(peer, `insert into orders (id, note) values (1, 'ours')`);
		await receiveForeignRow(12);
		await localWrite(peer, `insert into orders (id, note) values (2, 'ours')`);
		await receiveForeignRow(13);
		await receiveForeignRow(14);

		for (const since of [undefined, firstForeignRow]) {
			const batches = await drain(since);

			const rowIds = batches.map(batch => batch.flatMap(cs => cs.changes).map(change => Number(change.pk[0])));
			expect(rowIds, 'whole own transactions, one per batch').to.deep.equal([[1, 1], [2, 2]]);

			const sets = batches.flat();
			expect(sets.flatMap(cs => cs.schemaMigrations).map(migration => migration.table)).to.deep.equal(['our_table']);
			expect(sets.every(cs => siteIdEquals(cs.siteId, peer.manager.getSiteId())), 'nothing from another device').to.equal(true);
		}
	});
});
