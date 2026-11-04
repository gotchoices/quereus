/**
 * Sync bookkeeping (`cv:` / `tb:` / `cl:`) used to be filed under the table NAME, so a
 * rename stranded every record written before it under a name that no longer existed,
 * and a same-name re-create inherited the dropped incarnation's records
 * (`bug-sync-metadata-keyed-by-unstable-table-identity`, arms A and B). The records are
 * now filed under a per-peer table GENERATION that a rename moves and a drop retires
 * (`metadata/table-identity.ts`).
 *
 * The sequence below is an ordinary in-flight-edit race that converges WITHOUT the
 * rename (the control spec): a deletes a row while b still holds a stale edit of it,
 * then the two exchange. Delete-wins resolves it on both sides. A `rename to` between
 * a's delete and the exchange must leave the same outcome: both facts travel under the
 * table's CURRENT name and land against the table's own history.
 */

import { expect } from 'chai';
import type { PrimaryKeyRekeyedEvent } from '../../src/sync/events.js';
import { buildTableColumnVersionScanBounds, buildTombstoneScanBounds } from '../../src/metadata/keys.js';
import {
	changesFor,
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	type Peer,
} from './_peer-harness.js';

/** `orders` with a spare non-key column for the sibling ticket's primary-key change. */
const WIDE_ORDERS_DDL = 'create table orders (id integer primary key, note text, extra text) using store';

/**
 * Hold the peer's next commit capture until released. The capture is enqueued by the
 * engine's commit and serialized behind every earlier one, so holding the first
 * handler's entry delays every capture enqueued meanwhile — the way a slow metadata
 * store lets the engine run ahead of the capture. Nothing public delays it.
 */
function holdNextCapture(peer: Peer): () => void {
	const manager = peer.manager as unknown as { handleTransactionCommit: (batch: unknown) => Promise<void> };
	const original = manager.handleTransactionCommit;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	manager.handleTransactionCommit = async function (batch) {
		await gate;
		manager.handleTransactionCommit = original;
		return original.call(this, batch);
	};
	return release;
}

/** Two peers that each created `orders` and have reconciled those two creates. */
async function makeReconciledPair(): Promise<[Peer, Peer]> {
	const a = await makePeer('a', { createOrders: true, ordersDdl: WIDE_ORDERS_DDL });
	const b = await makePeer('b', { createOrders: true, ordersDdl: WIDE_ORDERS_DDL });
	await relayAll(a, b);
	await relayAll(b, a);
	return [a, b];
}

/**
 * The race: a seeds row 1 on both peers; b edits it (in flight); a deletes it; then
 * `betweenDeleteAndExchange` runs on a; then the two exchange both ways.
 */
async function runDeleteVsStaleEditRace(
	a: Peer,
	b: Peer,
	betweenDeleteAndExchange: () => Promise<void>,
): Promise<void> {
	await localWrite(a, "insert into orders (id, note, extra) values (1, 'seed', 'x')");
	await relayAll(a, b);
	expect(await collect(b.db, 'select note from orders where id = 1')).to.deep.equal([{ note: 'seed' }]);

	await localWrite(b, "update orders set note = 'stale' where id = 1");
	await localWrite(a, 'delete from orders where id = 1');
	await betweenDeleteAndExchange();

	await relayAll(a, b);
	await relayAll(b, a);
}

describe('sync bookkeeping follows the table across a rename and its rows across a primary-key change', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeReconciledPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('control: without a rename the delete wins on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {});

		expect(await collect(a.db, 'select id from orders'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders'), 'b has no row 1').to.deep.equal([]);
	});

	it('a rename between the delete and the exchange still lets the delete win on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {
			await localWrite(a, 'alter table orders rename to orders2');
		});

		expect(await collect(a.db, 'select id from orders2'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders2'), 'b has no row 1').to.deep.equal([]);
	});

	it('a primary-key change between the delete and the exchange still lets the delete win on both peers', async () => {
		await runDeleteVsStaleEditRace(a, b, async () => {
			await localWrite(a, 'alter table orders alter primary key (id, extra)');
		});

		expect(await collect(a.db, 'select id from orders'), 'a has no row 1').to.deep.equal([]);
		expect(await collect(b.db, 'select id from orders'), 'b has no row 1').to.deep.equal([]);
	});

	// The live-row arm: a's newer edit must beat b's older one on both peers, and the
	// key change must not leave b anything stale to ship. Without the re-key pass b's
	// stale cell stays filed under the old key and travels back to a addressed by a
	// one-column pk a's re-keyed table cannot resolve.
	it('a primary-key change between a newer edit and the exchange still lets the newer edit win on both peers', async () => {
		await localWrite(a, "insert into orders (id, note, extra) values (1, 'one', 'x')");
		await localWrite(a, "insert into orders (id, note, extra) values (2, 'two', 'y')");
		await relayAll(a, b);
		await localWrite(b, "update orders set note = 'stale' where id = 2");
		await localWrite(a, "update orders set note = 'fresh' where id = 2");

		const rekeys: PrimaryKeyRekeyedEvent[] = [];
		a.manager.getEventEmitter().onPrimaryKeyRekeyed(e => rekeys.push(e));
		await localWrite(a, 'alter table orders alter primary key (id, extra)');
		expect(rekeys, 'a re-filed every cell of both rows and dropped nothing').to.deep.equal([{
			schema: 'main', table: 'orders',
			cellsRekeyed: 6, rowsRekeyed: 2, rowsDropped: 0, rowsStranded: 0, tombstonesRekeyed: 0, tombstonesDropped: 0,
		}]);

		await relayAll(a, b);
		await relayAll(b, a);

		const expected = [{ id: 1, note: 'one' }, { id: 2, note: 'fresh' }];
		expect(await collect(a.db, 'select id, note from orders order by id'), 'a').to.deep.equal(expected);
		expect(await collect(b.db, 'select id, note from orders order by id'), 'b').to.deep.equal(expected);
	});

	// Two key changes, the second committed before the first's capture runs: the catalog
	// is already at (id, note) when the (id) → (id, extra) capture runs. Each capture must
	// re-file the transition its own statement made, so the second finds the records where
	// the first left them; a pass that re-filed to the catalog's key would leave the second
	// looking under (id, extra) for records filed under (id, note), and dropping them all.
	// On b the same two statements arrive in one batch and re-file in sequence.
	it('two primary-key changes committed before the first capture runs re-file in sequence on both peers', async () => {
		await localWrite(a, "insert into orders (id, note, extra) values (1, 'one', 'x')");
		await localWrite(a, "insert into orders (id, note, extra) values (2, 'two', 'y')");
		await relayAll(a, b);
		const rekeys = new Map<Peer, PrimaryKeyRekeyedEvent[]>([[a, []], [b, []]]);
		for (const peer of [a, b]) peer.manager.getEventEmitter().onPrimaryKeyRekeyed(e => rekeys.get(peer)!.push(e));

		const release = holdNextCapture(a);
		await a.db.exec('alter table orders alter primary key (id, extra)');
		await a.db.exec('alter table orders alter primary key (id, note)');
		release();
		await a.manager.whenCommitsSettled();
		await relayAll(a, b);

		for (const peer of [a, b]) {
			expect(rekeys.get(peer)!.map(e => [e.rowsRekeyed, e.rowsDropped]), `${peer.name} re-filed both rows twice`)
				.to.deep.equal([[2, 0], [2, 0]]);
			// b authored nothing, so excluding its site shows every record on either peer.
			const pks = (await changesFor(peer, b.manager.getSiteId())).map(c => c.pk);
			expect(pks, `${peer.name}'s log addresses every record by the final key`).to.have.length(6);
			expect(pks.every(pk => pk.length === 2 && typeof pk[1] === 'string'), `${peer.name}: ${JSON.stringify(pks)}`).to.equal(true);
		}
	});
});

/**
 * What one generation holds, counted raw from the KV store: the record readers
 * resolve by name, so they cannot see a retired generation's records.
 */
async function generationFootprint(peer: Peer, generation: string): Promise<{ cv: number; tb: number; cl: number }> {
	const count = async (entries: AsyncIterable<unknown>): Promise<number> => {
		let n = 0;
		for await (const _entry of entries) n++;
		return n;
	};
	let cl = 0;
	for await (const entry of peer.manager.changeLog.getAllChanges()) {
		if (entry.generation === generation) cl++;
	}
	return {
		cv: await count(peer.manager.kv.iterate(buildTableColumnVersionScanBounds(generation))),
		tb: await count(peer.manager.kv.iterate(buildTombstoneScanBounds(generation))),
		cl,
	};
}

describe('sync bookkeeping does not outlive a dropped table', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeReconciledPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	// Arm B of the original ticket, relayed in SEPARATE batches: the in-batch case is
	// `drop-recreate-batch.spec.ts`'s, where `computeBatchTableFates` already resolves the
	// re-created table read-free. Here the drop/re-create lands on every peer BEFORE the
	// new incarnation's first row is written, so nothing in the batch says "fresh" — only
	// the retired generation keeps a's old tombstone from blocking b's row.
	it('a row written into a re-created table is not blocked by the dropped incarnation\'s tombstone', async () => {
		await localWrite(a, "insert into orders (id, note, extra) values (1, 'seed', 'x')");
		await relayAll(a, b);
		await localWrite(a, 'delete from orders where id = 1');
		await relayAll(a, b);
		expect(await collect(b.db, 'select id from orders'), 'the delete reached b').to.deep.equal([]);

		await localWrite(a, 'drop table orders');
		await localWrite(a, WIDE_ORDERS_DDL);
		await relayAll(a, b);

		await localWrite(b, "insert into orders (id, note, extra) values (1, 'reborn', 'y')");
		await relayAll(b, a);

		expect(await collect(a.db, 'select id, note from orders'), 'a holds b\'s row').to.deep.equal([{ id: 1, note: 'reborn' }]);
		expect(await collect(b.db, 'select id, note from orders'), 'b keeps its row').to.deep.equal([{ id: 1, note: 'reborn' }]);
	});

	// a runs the local drop and b the replicated one, so both retire callers are covered.
	it('a drop deletes the table\'s cell versions and tombstones, and the next repair sweep its change-log entries', async () => {
		await localWrite(a, "insert into orders (id, note, extra) values (1, 'kept', 'x')");
		await localWrite(a, "insert into orders (id, note, extra) values (2, 'gone', 'y')");
		await localWrite(a, 'delete from orders where id = 2');
		await relayAll(a, b);

		const peers = [a, b].map(peer => ({ peer, generation: peer.manager.tableIdentity.generationOf('main', 'orders')! }));
		const logged: number[] = [];
		for (const { peer, generation } of peers) {
			const before = await generationFootprint(peer, generation);
			expect(before.cv, `${peer.name} holds cell versions`).to.be.greaterThan(0);
			expect(before.tb, `${peer.name} holds the tombstone`).to.equal(1);
			expect(before.cl, `${peer.name} indexes both`).to.equal(before.cv + before.tb);
			logged.push(before.cl);
		}

		await localWrite(a, 'drop table orders');
		await relayAll(a, b);

		for (const [i, { peer, generation }] of peers.entries()) {
			expect(peer.manager.tableIdentity.generationOf('main', 'orders'), `the drop reached ${peer.name}`).to.equal(undefined);
			expect(await generationFootprint(peer, generation), `${peer.name} after the drop`)
				.to.deep.equal({ cv: 0, tb: 0, cl: logged[i] });

			expect(await peer.manager.repairChangeLog(), `${peer.name} repair count`).to.equal(logged[i]);
			expect((await generationFootprint(peer, generation)).cl, `${peer.name} after repair`).to.equal(0);
		}
	});
});
