/**
 * A relay — a peer with sync records but no catalog and no table — re-files a table's
 * records from the records themselves when a replicated `alter primary key` runs
 * (`sync/rekey-on-pk-change.ts`, the relay variant). Specs drive a relay-only manager
 * with hand-built changes, as the coordinator receives them.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type PrimaryKeyRekeyedEvent } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type Change, type ChangeSet, type SchemaMigration } from '../../src/sync/protocol.js';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

const origin = generateSiteId();
const startedAt = BigInt(Date.now()) - 60_000n;
let clock = 0;
const nextHlc = (): HLC => createHLC(startedAt + BigInt(++clock), 0, origin);

/** The writer's layout of `orders`, as its `alter primary key` migration carries it. */
const COLUMNS = ['id', 'note', 'qty'];

async function makeRelay(): Promise<{ relay: SyncManagerImpl; rekeys: PrimaryKeyRekeyedEvent[] }> {
	const events = new SyncEventEmitterImpl();
	const rekeys: PrimaryKeyRekeyedEvent[] = [];
	events.onPrimaryKeyRekeyed(event => rekeys.push(event));
	const relay = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		undefined,
		{ ...DEFAULT_SYNC_CONFIG, retentionHorizonMs: -1 },
		events,
	);
	return { relay, rekeys };
}

const changeSet = (changes: Change[], schemaMigrations: SchemaMigration[] = []): ChangeSet => ({
	siteId: origin,
	transactionId: crypto.randomUUID(),
	hlc: nextHlc(),
	changes,
	schemaMigrations,
});

const cell = (pk: SqlValue[], column: string, value: SqlValue): Change =>
	({ type: 'column', schema: 'main', table: 'orders', pk, column, value, hlc: nextHlc() });

/** A whole row written under the key `(id)`, one cell per column. */
const row = (id: number, note: string, qty: number): Change[] =>
	[cell([id], 'id', id), cell([id], 'note', note), cell([id], 'qty', qty)];

const deletion = (pk: SqlValue[], priorRow?: SqlValue[]): Change =>
	({ type: 'delete', schema: 'main', table: 'orders', pk, hlc: nextHlc(), ...(priorRow ? { priorRow } : {}) });

/** `columns: null` is a migration carrying no column list (an explicit `undefined` would take the default). */
const redefineKey = (keyColumns: string, columns: string[] | null = COLUMNS): SchemaMigration => ({
	type: 'alter_column',
	schema: 'main',
	table: 'orders',
	ddl: `alter table orders alter primary key (${keyColumns})`,
	...(columns ? { columns } : {}),
	hlc: nextHlc(),
	schemaVersion: 2,
});

/** Every fact the relay would ship, as `column@pk=value` / `delete@pk`, sorted. */
async function recordsOf(relay: SyncManagerImpl): Promise<string[]> {
	const sets = await relay.getChangesSince(generateSiteId());
	return sets
		.flatMap(set => set.changes)
		.map(change => change.type === 'column'
			? `${change.column}@${JSON.stringify(change.pk)}=${JSON.stringify(change.value)}`
			: `delete@${JSON.stringify(change.pk)}`)
		.sort();
}

async function changeLogEntries(relay: SyncManagerImpl): Promise<number> {
	let count = 0;
	for await (const _entry of relay.changeLog.getAllChanges()) count++;
	return count;
}

async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: unknown) => warnings.push(String(message));
	try {
		await run();
	} finally {
		console.warn = original;
	}
	return warnings;
}

describe('a relay re-files its records when a replicated primary key change runs', () => {
	it('reads each row\'s new key from its cells, matching the statement\'s column names case-insensitively', async () => {
		const { relay, rekeys } = await makeRelay();
		await relay.applyChanges([changeSet([...row(1, 'one', 1), ...row(2, 'two', 2)])]);

		await relay.applyChanges([changeSet([], [redefineKey('id, QTY')])]);

		expect(await recordsOf(relay)).to.deep.equal([
			'id@[1,1]=1', 'id@[2,2]=2', 'note@[1,1]="one"', 'note@[2,2]="two"', 'qty@[1,1]=1', 'qty@[2,2]=2',
		]);
		expect(rekeys).to.deep.equal([{
			schema: 'main', table: 'orders',
			cellsRekeyed: 6, rowsRekeyed: 2, rowsDropped: 0, rowsStranded: 0, tombstonesRekeyed: 0, tombstonesDropped: 0,
		}]);
	});

	it('moves a tombstone to the key read from its before-image, laid out as the migration\'s column list', async () => {
		const { relay, rekeys } = await makeRelay();
		await relay.applyChanges([changeSet([...row(1, 'one', 1)])]);
		await relay.applyChanges([changeSet([deletion([3], [3, 'three', 3])])]);

		await relay.applyChanges([changeSet([], [redefineKey('id, qty')])]);

		expect(await recordsOf(relay)).to.deep.equal(['delete@[3,3]', 'id@[1,1]=1', 'note@[1,1]="one"', 'qty@[1,1]=1']);
		expect(rekeys[0]).to.include({ tombstonesRekeyed: 1, tombstonesDropped: 0 });
	});

	it('drops a tombstone when the migration carries no column list, since the before-image cannot be read', async () => {
		const { relay, rekeys } = await makeRelay();
		await relay.applyChanges([changeSet([deletion([3], [3, 'three', 3])])]);

		await relay.applyChanges([changeSet([], [redefineKey('id, qty', null)])]);

		expect(await recordsOf(relay)).to.deep.equal([]);
		expect(rekeys[0]).to.include({ tombstonesRekeyed: 0, tombstonesDropped: 1 });
	});

	it('leaves a row whose key column has no cell where it is, counted and warned about', async () => {
		const { relay, rekeys } = await makeRelay();
		await relay.applyChanges([changeSet([...row(1, 'one', 1), cell([4], 'id', 4), cell([4], 'note', 'no qty')])]);

		const warnings = await captureWarnings(async () => {
			await relay.applyChanges([changeSet([], [redefineKey('id, qty')])]);
		});

		expect(await recordsOf(relay)).to.deep.equal([
			'id@[1,1]=1', 'id@[4]=4', 'note@[1,1]="one"', 'note@[4]="no qty"', 'qty@[1,1]=1',
		]);
		expect(rekeys[0]).to.include({ rowsRekeyed: 1, rowsStranded: 1, rowsDropped: 0 });
		expect(warnings.some(warning => warning.includes('left 1 row(s) under the old key')), warnings.join('\n')).to.equal(true);
	});

	it('keeps the newer cell, and one change-log entry, when two rows land on one new key', async () => {
		const { relay, rekeys } = await makeRelay();
		await relay.applyChanges([changeSet([cell([1], 'id', 1), cell([1], 'note', 'older'), cell([1], 'qty', 7)])]);
		await relay.applyChanges([changeSet([cell([2], 'id', 2), cell([2], 'note', 'newer'), cell([2], 'qty', 7)])]);

		await relay.applyChanges([changeSet([], [redefineKey('qty')])]);

		expect(await recordsOf(relay)).to.deep.equal(['id@[7]=2', 'note@[7]="newer"', 'qty@[7]=7']);
		expect(await changeLogEntries(relay)).to.equal(3);
		expect(rekeys[0]).to.include({ cellsRekeyed: 3, rowsRekeyed: 2 });
	});

	it('two concurrent applies of one key change leave every row under the new key', async () => {
		const { relay } = await makeRelay();
		await relay.applyChanges([changeSet([...row(1, 'one', 1), ...row(2, 'two', 2)])]);
		const keyChange = changeSet([], [redefineKey('id, qty')]);

		await Promise.all([relay.applyChanges([keyChange]), relay.applyChanges([keyChange])]);

		expect(await recordsOf(relay)).to.deep.equal([
			'id@[1,1]=1', 'id@[2,2]=2', 'note@[1,1]="one"', 'note@[2,2]="two"', 'qty@[1,1]=1', 'qty@[2,2]=2',
		]);
		expect(await changeLogEntries(relay)).to.equal(6);
	});
});
