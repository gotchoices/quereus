/**
 * A tombstone is also how a local delete reaches the server, so expiry must keep any
 * delete this replica has not delivered. Without that, a device offline past the
 * retention horizon forgets its deletes and the rows come back when it reconnects.
 */

import { expect } from 'chai';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
import type { SiteId } from '../../src/clock/site.js';
import type { ChangeSet } from '../../src/sync/protocol.js';
import { closePeer, collect, flattenSets, localWrite, makePeer, relay, settle, type Peer } from './_peer-harness.js';

const INSERT_ROW = "insert into orders values (1, 'one')";
const DELETE_ROW = 'delete from orders where id = 1';

/** The newest write in `sets`: the `create table` migration comes first, in its own set. */
const newestHlc = (sets: ChangeSet[]): HLC => sets[sets.length - 1].hlc;

describe('pruneTombstones keeps deletes this replica has not delivered', () => {
	let device: Peer;
	let server: Peer;
	let serverId: SiteId;

	beforeEach(async () => {
		// A negative horizon: every tombstone on the device has already expired.
		device = await makePeer('device', { createOrders: true, config: { retentionHorizonMs: -1 } });
		server = await makePeer('server', { createOrders: true });
		serverId = server.manager.getSiteId();
	});

	afterEach(async () => {
		await closePeer(device);
		await closePeer(server);
	});

	async function pendingPush(): Promise<ChangeSet[]> {
		await settle();
		return device.manager.getChangesToPush(serverId, await device.manager.getPeerSentState(serverId));
	}

	/** Push what is pending and record the server's acknowledgement, as the sync client does. */
	async function push(): Promise<HLC> {
		const sets = await pendingPush();
		await server.manager.applyChanges(sets.map(set => ({ ...set, schemaMigrations: [] })));
		const acknowledged = newestHlc(sets);
		await device.manager.updatePeerSentState(serverId, acknowledged);
		return acknowledged;
	}

	it('keeps an expired delete above the watermark, and still pushes it', async () => {
		await localWrite(device, INSERT_ROW);
		await push();
		await localWrite(device, DELETE_ROW);

		expect(await device.manager.pruneTombstones()).to.equal(0);

		expect(flattenSets(await pendingPush()).map(change => change.type)).to.deep.equal(['delete']);
		await push();
		expect(await collect(server.db, 'select id from orders')).to.deep.equal([]);
	});

	it('keeps an expired delete when no push has ever been acknowledged', async () => {
		await localWrite(device, INSERT_ROW);
		await localWrite(device, DELETE_ROW);

		expect(await device.manager.pruneTombstones()).to.equal(0);

		expect(flattenSets(await pendingPush()).map(change => change.type)).to.deep.equal(['delete']);
	});

	it('prunes on the sweep after the watermark reaches it, raising the floor only then', async () => {
		await localWrite(device, INSERT_ROW);
		await localWrite(device, DELETE_ROW);
		expect(await device.manager.pruneTombstones()).to.equal(0);
		expect(await device.manager.getDeltaFloor()).to.equal(undefined);

		const acknowledged = await push();

		expect(await device.manager.pruneTombstones()).to.equal(1);
		expect(await device.manager.getDeltaFloor()).to.deep.equal(acknowledged);
	});

	it('goes by the lowest watermark when several servers have one', async () => {
		await localWrite(device, INSERT_ROW);
		const beforeDelete = newestHlc(await pendingPush());
		await localWrite(device, DELETE_ROW);
		const deleted = newestHlc(await pendingPush());

		// Fixed ids put the lowest record between the others, whatever order the scan favours.
		const [ahead1, behind, ahead2] = [1, 2, 3].map(fill => new Uint8Array(16).fill(fill));
		await device.manager.updatePeerSentState(ahead1, deleted);
		await device.manager.updatePeerSentState(behind, beforeDelete);
		await device.manager.updatePeerSentState(ahead2, deleted);
		expect(await device.manager.pruneTombstones()).to.equal(0);

		await device.manager.updatePeerSentState(behind, deleted);
		expect(await device.manager.pruneTombstones()).to.equal(1);
	});

	describe("another device's expired delete", () => {
		beforeEach(async () => {
			await localWrite(server, INSERT_ROW);
			await localWrite(server, DELETE_ROW);
			await relay(server, device);
		});

		it('prunes on a device with no watermark, which only receives', async () => {
			expect(await device.manager.pruneTombstones()).to.equal(1);
		});

		it('prunes on a device whose watermark is below it', async () => {
			await device.manager.updatePeerSentState(serverId, createHLC(1n, 0, device.manager.getSiteId()));
			expect(await device.manager.pruneTombstones()).to.equal(1);
		});
	});
});
