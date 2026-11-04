/**
 * A replica that has pruned a tombstone cannot tell a deleted row from one it never
 * heard of. An edit of such a row would bring back a fragment, so `applyChanges` refuses
 * it: docs/sync.md § Tombstones and Deletions. Specs drive a relay-only manager, the
 * shape of the coordinator, with hand-built changes unless a real device is the subject.
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

	it('is accepted for a new row whose key spelling and other cells were rewritten before its first push', async () => {
		const device = await makePeer('device', {
			createOrders: true,
			ordersDdl: 'create table orders (id text collate nocase primary key, note text) using store',
		});
		await localWrite(device, `insert into orders (id, note) values ('A', 'new')`);
		await localWrite(device, `update orders set id = 'a', note = 'edited offline' where id = 'A'`);
		const server = await makeServer();
		await pruneAnUnrelatedDelete(server);

		const result = await server.applyChanges(await device.manager.getChangesSince(server.getSiteId()));
		await closePeer(device);

		expect(result.skipped).to.equal(0);
		expect(await cellsOf(server, ['a'])).to.deep.equal(['id', 'note']);
	});

	it('is accepted for a row two devices first-wrote, when a relay passes it to a replica that has pruned', async () => {
		const relay = await makeServer();
		for (const value of ['from one device', 'from another']) {
			await relay.applyChanges([changeSet([founding([1], 'id', 1), founding([1], 'note', value)])]);
		}
		const replica = await makeServer();
		await pruneAnUnrelatedDelete(replica);

		const result = await replica.applyChanges(await relay.getChangesSince(replica.getSiteId()));

		expect(result.skipped).to.equal(0);
		expect(await cellsOf(replica, [1])).to.deep.equal(['id', 'note']);
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

	const renameOrders = (): SchemaMigration => ({
		type: 'rename_table',
		schema: 'main',
		table: 'renamed',
		fromTable: 'orders',
		ddl: 'alter table orders rename to renamed',
		hlc: nextHlc(),
		schemaVersion: 3,
	});

	const editOfRenamed = (pk: SqlValue[], column: string): ColumnChange => ({ ...edit(pk, column, 5), table: 'renamed' });

	it('is accepted when the same batch renames the table, while a relay still holds its records under the old name', async () => {
		const server = await makeServer();
		await pruneAnUnrelatedDelete(server);
		await server.applyChanges([changeSet([founding([1], 'id', 1)])]);

		const result = await server.applyChanges([changeSet([editOfRenamed([1], 'qty')], [renameOrders()])]);

		expect(result.skipped).to.equal(0);
	});

	describe('on a table whose primary key was redefined', () => {
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

		// The relay re-filed its records under the new key when the earlier batch ran, so a
		// row with none there is one it has forgotten, as on any other table.
		it('is refused when an earlier batch redefined the key and the row was never founded', async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);
			await server.applyChanges([changeSet([], [redefineKey()])]);

			const result = await server.applyChanges([changeSet([edit([1, 'one'], 'qty', 5)])]);

			expect(result.skipped).to.equal(1);
			expect(await cellsOf(server, [1, 'one'])).to.deep.equal([]);
		});

		it('is refused when an earlier batch redefined the key and a later one renamed the table', async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);
			await server.applyChanges([changeSet([], [redefineKey()])]);
			await server.applyChanges([changeSet([], [renameOrders()])]);

			const result = await server.applyChanges([changeSet([editOfRenamed([1, 'one'], 'qty')])]);

			expect(result.skipped).to.equal(1);
		});

		it('is accepted for a row the relay re-filed under the new key', async () => {
			const server = await makeServer();
			await pruneAnUnrelatedDelete(server);
			await server.applyChanges([changeSet([founding([1], 'id', 1), founding([1], 'note', 'one')])]);
			await server.applyChanges([changeSet([], [redefineKey()])]);

			const result = await server.applyChanges([changeSet([edit([1, 'one'], 'qty', 5)])]);

			expect(result.skipped).to.equal(0);
			expect(await cellsOf(server, [1, 'one'])).to.deep.equal(['id', 'note', 'qty']);
		});
	});
});

describe('recording a local update', () => {
	it('leaves an untouched blob cell at the version it had', async () => {
		const device = await makePeer('device', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, data blob, note text) using store',
		});
		await localWrite(device, `insert into orders values (1, x'01', 'new')`);
		const before = await device.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'data');

		await localWrite(device, `update orders set note = 'edited' where id = 1`);

		const after = await device.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'data');
		await closePeer(device);
		expect(before).to.exist;
		expect(after).to.deep.equal(before);
	});
});
