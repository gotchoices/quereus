/**
 * A change that reaches a server late must still reach every device that catches up
 * with that server, however old its write timestamp is: the received watermark counts
 * how far through the server's filing order a device has read, not write time.
 * See docs/sync-protocol.md § Delta Sync Optimization.
 */

import { expect } from 'chai';
import { closePeer, collect, COLUMNS_PER_FRESH_INSERT, makePeer, settle, toStream, type Peer } from './_peer-harness.js';
import { maxHLC } from '../../src/clock/hlc.js';
import { replyWatermark, type ChangeSet, type SnapshotChunk, type SyncConfig } from '../../src/sync/protocol.js';
import { deserializeSnapshotChunk, serializeSnapshotChunk } from '../../src/sync/wire.js';

const ORDERS_DDL = 'create table orders (id integer primary key, note text) using store';

/** Send everything `from` wrote past its sent watermark for `to`, as a client's push does. */
async function push(from: Peer, to: Peer): Promise<void> {
	await settle();
	const toSite = to.manager.getSiteId();
	const sets = await from.manager.getChangesToPush(toSite, await from.manager.getPeerSentState(toSite));
	if (sets.length === 0) return;
	await to.manager.applyChanges(sets);
	await from.manager.updatePeerSentState(toSite, maxHLC(sets.map(cs => cs.hlc))!);
	await settle();
}

/** Read from `from` a batch at a time, from `to`'s received watermark, until a reply is empty. */
async function pull(from: Peer, to: Peer): Promise<ChangeSet[][]> {
	await settle();
	const fromSite = from.manager.getSiteId();
	const replies: ChangeSet[][] = [];
	for (let read = 0; read < 50; read++) {
		const reply = await from.manager.getChangesSince(to.manager.getSiteId(), await to.manager.getPeerSyncState(fromSite));
		if (reply.length === 0) return replies;
		replies.push(reply);
		await to.manager.applyChanges(reply);
		await to.manager.updatePeerSyncState(fromSite, replyWatermark(reply)!);
		await settle();
	}
	throw new Error('still reading after 50 replies: the watermark is not advancing');
}

/** Replace `to`'s contents with `from`'s snapshot; its header is then the received watermark. */
async function bootstrap(from: Peer, to: Peer): Promise<void> {
	await settle();
	const snapshot = await from.manager.getSnapshot();
	await to.manager.applySnapshot(snapshot);
	await to.manager.updatePeerSyncState(from.manager.getSiteId(), snapshot.hlc);
	await settle();
}

const rowIds = async (peer: Peer, table = 'orders'): Promise<number[]> =>
	(await collect(peer.db, `select id from ${table} order by id`)).map(row => Number(row.id));

describe('a change that reaches the server after a device read past its write time', () => {
	let b: Peer;
	let s: Peer;
	let c: Peer;
	let d: Peer;
	const extraPeers: Peer[] = [];

	/** B writes row 1 and pushes it; every other device reads it from the server. */
	async function setUp(serverConfig?: Partial<SyncConfig>): Promise<void> {
		[b, c, d] = await Promise.all(['B', 'C', 'D'].map(name => makePeer(name)));
		s = await makePeer('S', { config: serverConfig });
		await b.db.exec(ORDERS_DDL);
		await b.db.exec(`insert into orders values (1, 'one')`);
		await push(b, s);
		await pull(s, c);
		await pull(s, d);
	}

	afterEach(async () => {
		await Promise.all([b, s, c, d, ...extraPeers.splice(0)].map(closePeer));
	});

	describe('is delivered to that device', () => {
		beforeEach(() => setUp());

		const newerChangeFrom = {
			'a local write on the server': async (): Promise<void> => {
				await s.db.exec(`insert into orders values (2, 'newer')`);
			},
			'a third device pushing to the server': async (): Promise<void> => {
				await d.db.exec(`insert into orders values (2, 'newer')`);
				await push(d, s);
			},
		};

		const cases: Array<{
			offline: string;
			sql: string;
			newer: keyof typeof newerChangeFrom;
			catchUp: 'pull' | 'snapshot';
			expectOnC: () => Promise<unknown>;
		}> = [
			{
				offline: 'a delete', sql: 'delete from orders where id = 1',
				newer: 'a local write on the server', catchUp: 'pull',
				expectOnC: async () => expect(await rowIds(c)).to.deep.equal([2]),
			},
			{
				offline: 'an update', sql: `update orders set note = 'edited' where id = 1`,
				newer: 'a local write on the server', catchUp: 'pull',
				expectOnC: async () => expect(await collect(c.db, 'select note from orders where id = 1')).to.deep.equal([{ note: 'edited' }]),
			},
			{
				offline: 'an insert', sql: `insert into orders values (3, 'three')`,
				newer: 'a local write on the server', catchUp: 'pull',
				expectOnC: async () => expect(await rowIds(c)).to.deep.equal([1, 2, 3]),
			},
			{
				offline: 'a new table with a row',
				sql: `create table extra (id integer primary key, v text) using store; insert into extra values (7, 'x')`,
				newer: 'a local write on the server', catchUp: 'pull',
				expectOnC: async () => expect(await rowIds(c, 'extra')).to.deep.equal([7]),
			},
			{
				offline: 'a delete', sql: 'delete from orders where id = 1',
				newer: 'a third device pushing to the server', catchUp: 'pull',
				expectOnC: async () => expect(await rowIds(c)).to.deep.equal([2]),
			},
			{
				offline: 'a delete', sql: 'delete from orders where id = 1',
				newer: 'a local write on the server', catchUp: 'snapshot',
				expectOnC: async () => expect(await rowIds(c)).to.deep.equal([2]),
			},
		];

		for (const { offline, sql, newer, catchUp, expectOnC } of cases) {
			it(`${offline} made offline, when the newer change was ${newer} and the device caught up by ${catchUp}`, async () => {
				await b.db.exec(sql);
				// Long enough that the newer change's write time is after the offline one's.
				await settle();
				await newerChangeFrom[newer]();
				if (catchUp === 'pull') await pull(s, c);
				else await bootstrap(s, c);

				await push(b, s);
				await pull(s, c);

				await expectOnC();
			});
		}

		it('as is a change written after the device last caught up', async () => {
			await s.db.exec(`insert into orders values (2, 'newer')`);
			await pull(s, c);
			await b.db.exec('delete from orders where id = 1');

			await push(b, s);
			await pull(s, c);

			expect(await rowIds(c)).to.deep.equal([2]);
		});
	});

	it('is delivered when replies are cut between late and on-time transactions, each transaction once', async () => {
		// One insert fills a reply, so every reply is cut after a single transaction.
		await setUp({ batchSize: COLUMNS_PER_FRESH_INSERT });
		await b.db.exec(`insert into orders values (3, 'late')`);
		await settle();
		await s.db.exec(`insert into orders values (2, 'on time')`);
		await s.db.exec(`insert into orders values (4, 'on time')`);
		await push(b, s);
		await s.db.exec(`insert into orders values (5, 'on time')`);

		const replies = await pull(s, c);

		expect(await rowIds(c)).to.deep.equal([1, 2, 3, 4, 5]);
		const delivered = replies.flat().map(cs => cs.transactionId);
		expect(delivered).to.have.lengthOf(4);
		expect(new Set(delivered).size, 'a transaction was delivered twice').to.equal(4);
	});

	it('is still served by a replica restored from the server\'s stored snapshot, to a device that had read past its write time', async () => {
		await setUp();
		await b.db.exec(`insert into orders values (3, 'late')`);
		await b.db.exec('delete from orders where id = 1');
		await settle();
		await s.db.exec(`insert into orders values (2, 'newer')`);
		await pull(s, c);
		await push(b, s);

		// The server is rebuilt from a snapshot it stored, as serialized chunks, keeping its site id.
		const stored: SnapshotChunk[] = [];
		for await (const chunk of s.manager.getSnapshotStream()) {
			stored.push(deserializeSnapshotChunk(JSON.parse(JSON.stringify(serializeSnapshotChunk(chunk)))));
		}
		const restored = await makePeer('S restored', { config: { siteId: s.manager.getSiteId() } });
		extraPeers.push(restored);
		await restored.manager.applySnapshotStream(toStream(stored));

		await pull(restored, c);

		expect(await rowIds(c)).to.deep.equal([2, 3]);
	});

	it('does not make a device restored from the server\'s snapshot push its own earlier writes again', async () => {
		await setUp();
		const server = s.manager.getSiteId();

		await bootstrap(s, b);

		expect(await b.manager.getChangesToPush(server, await b.manager.getPeerSentState(server))).to.deep.equal([]);
	});
});
