/**
 * A replica that has pruned a tombstone cannot tell a deleted row from one it never
 * heard of. An edit of such a row would bring back a fragment, so `applyChanges` refuses
 * it: docs/sync.md § Tombstones and Deletions. Each spec drives a relay-only manager, the
 * shape of the coordinator, with hand-built changes.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
	DEFAULT_SYNC_CONFIG,
	type Change,
	type ChangeSet,
	type ColumnChange,
	type SchemaMigration,
	type SyncConfig,
} from '../../src/sync/protocol.js';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { closePeer, localWrite, makePeer } from './_peer-harness.js';

const origin = generateSiteId();
const startedAt = BigInt(Date.now()) - 60_000n;
let clock = 0;
const nextHlc = (): HLC => createHLC(startedAt + BigInt(++clock), 0, origin);

const makeServer = (config?: Partial<SyncConfig>): Promise<SyncManagerImpl> => SyncManagerImpl.create(
	new InMemoryKVStore(),
	undefined,
	{ ...DEFAULT_SYNC_CONFIG, retentionHorizonMs: -1, ...config },
	new SyncEventEmitterImpl(),
);

const changeSet = (changes: Change[], schemaMigrations: SchemaMigration[] = []): ChangeSet => ({
	siteId: origin,
	transactionId: crypto.randomUUID(),
	hlc: nextHlc(),
	changes,
	schemaMigrations,
});

/** A cell carrying no before-image: its row's first write. */
const founding = (pk: SqlValue[], column: string, value: SqlValue): ColumnChange =>
	({ type: 'column', schema: 'main', table: 'orders', pk, column, value, hlc: nextHlc() });

/** A cell whose writer saw an earlier version of it. */
const edit = (pk: SqlValue[], column: string, value: SqlValue): ColumnChange =>
	({ ...founding(pk, column, value), priorHlc: createHLC(startedAt, 0, origin), priorValue: 'before' });

/** Leave a delta floor behind: row 99 is deleted, then every tombstone is pruned. */
async function pruneAnUnrelatedDelete(server: SyncManagerImpl): Promise<void> {
	await server.applyChanges([changeSet([{ type: 'delete', schema: 'main', table: 'orders', pk: [99], hlc: nextHlc() }])]);
	expect(await server.pruneTombstones()).to.equal(1);
}

const cellsOf = async (server: SyncManagerImpl, pk: SqlValue[]): Promise<string[]> =>
	[...(await server.columnVersions.getRowVersions('main', 'orders', pk)).keys()].sort();

describe('an edit of a row this replica has forgotten', () => {
	it('is refused when only edits arrive for an unknown row after a prune', async () => {
		const server = await makeServer();
		await pruneAnUnrelatedDelete(server);

		const result = await server.applyChanges([changeSet([edit([1], 'note', 'edited offline')])]);

		expect(result.applied).to.equal(0);
		expect(result.skipped).to.equal(1);
		expect(await cellsOf(server, [1])).to.deep.equal([]);
	});

	for (const [order, arrange] of [
		['founding cell first', (cells: Change[]) => cells],
		['founding cell last', (cells: Change[]) => [...cells].reverse()],
	] as const) {
		it(`is accepted when the same batch founds the row (${order})`, async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);

			const result = await server.applyChanges([
				changeSet(arrange([founding([1], 'id', 1), edit([1], 'note', 'edited offline')])),
			]);

			expect(result.applied).to.equal(2);
			expect(await cellsOf(server, [1])).to.deep.equal(['id', 'note']);
		});
	}

	it('is accepted when an earlier batch founded the row', async () => {
		const server = await makeServer();
		await pruneAnUnrelatedDelete(server);

		await server.applyChanges([changeSet([founding([1], 'id', 1)])]);
		const result = await server.applyChanges([changeSet([edit([1], 'note', 'edited offline')])]);

		expect(result.applied).to.equal(1);
	});

	// A blob read back from a row is a new object each time, so comparing cells by
	// reference would make an update rewrite the key cell, leaving no founding cell.
	it('is accepted for a new row with a blob key edited before its first push', async () => {
		const device = await makePeer('device', {
			createOrders: true,
			ordersDdl: 'create table orders (id blob primary key, note text) using store',
		});
		await localWrite(device, `insert into orders (id, note) values (x'01', 'new')`);
		await localWrite(device, `update orders set note = 'edited offline' where id = x'01'`);
		const server = await makeServer();
		await pruneAnUnrelatedDelete(server);

		const result = await server.applyChanges(await device.manager.getChangesSince(server.getSiteId()));
		await closePeer(device);

		expect(result.skipped).to.equal(0);
		expect(await cellsOf(server, [new Uint8Array([1])])).to.deep.equal(['id', 'note']);
	});

	it('is accepted when this replica has never pruned', async () => {
		const server = await makeServer();

		const result = await server.applyChanges([changeSet([edit([1], 'note', 'edited offline')])]);

		expect(result.applied).to.equal(1);
	});

	it('is accepted under allowResurrection', async () => {
		const server = await makeServer({ allowResurrection: true });
		await pruneAnUnrelatedDelete(server);

		const result = await server.applyChanges([changeSet([edit([1], 'note', 'edited offline')])]);

		expect(result.applied).to.equal(1);
	});

	describe('on a table whose primary key was redefined, where a relay never re-files its records', () => {
		const redefineKey = (): SchemaMigration => ({
			type: 'alter_column',
			schema: 'main',
			table: 'orders',
			ddl: 'alter table orders alter primary key (id, note)',
			hlc: nextHlc(),
			schemaVersion: 2,
		});

		it('is accepted when the same batch redefines the key', async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);

			const result = await server.applyChanges([
				changeSet([edit([1, 'one'], 'qty', 5)], [redefineKey()]),
			]);

			expect(await cellsOf(server, [1, 'one'])).to.deep.equal(['qty']);
			expect(result.skipped).to.equal(0);
		});

		it('is accepted when an earlier batch redefined the key', async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);
			await server.applyChanges([changeSet([], [redefineKey()])]);

			const result = await server.applyChanges([changeSet([edit([1, 'one'], 'qty', 5)])]);

			expect(result.skipped).to.equal(0);
		});
	});
});
