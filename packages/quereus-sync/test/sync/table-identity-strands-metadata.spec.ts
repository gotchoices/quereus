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
import {
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	type Peer,
} from './_peer-harness.js';

/** `orders` with a spare non-key column for the sibling ticket's primary-key change. */
const WIDE_ORDERS_DDL = 'create table orders (id integer primary key, note text, extra text) using store';

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

describe('sync bookkeeping follows the table across a rename', () => {
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
});

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
});
