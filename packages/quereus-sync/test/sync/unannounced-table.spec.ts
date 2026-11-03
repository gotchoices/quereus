/**
 * A write to a table sync never announced — created before sync attached, so no
 * migration brings it into existence — carries the table's definition as a BASELINE
 * (`SchemaMigration.schemaVersion` 0): a device that lacks the table creates it, one
 * that has it keeps its own shape. See docs/sync.md § Rows sync has never recorded and
 * docs/sync-schema.md § Baselines.
 */

import { expect } from 'chai';
import { closePeer, collect, localWrite, makePeer, relayAll, settle, toStream, type Peer } from './_peer-harness.js';
import type { ChangeSet, SnapshotChunk } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';

const EXTRA = 'create table extra (id integer primary key, v text not null) using store';

describe('a write to a table sync never announced', () => {
	const open: Peer[] = [];
	const peer: typeof makePeer = async (...args) => {
		const made = await makePeer(...args);
		open.push(made);
		return made;
	};

	afterEach(async () => {
		await Promise.all(open.splice(0).map(closePeer));
	});

	async function chunksOf(from: Peer): Promise<SnapshotChunk[]> {
		const chunks: SnapshotChunk[] = [];
		for await (const chunk of from.manager.getSnapshotStream()) chunks.push(chunk);
		return chunks;
	}

	/** `type object@version` for every migration a peer's first push would carry, in wire order. */
	async function migrationsOf(from: Peer): Promise<string[]> {
		const sets = await from.manager.getChangesSince(generateSiteId());
		return sets.flatMap(set => set.schemaMigrations.map(m => `${m.type} ${m.table}@${m.schemaVersion}`));
	}

	const columnsOf = (of: Peer, table: string): string[] | undefined =>
		of.db.schemaManager.getTable('main', table)?.columns.map(column => column.name.toLowerCase());

	const indexesOf = (of: Peer, table: string): string[] =>
		of.db.schemaManager.getTable('main', table)?.indexes?.map(index => index.name) ?? [];

	type ApplyPath = 'delta' | 'streaming snapshot' | 'whole snapshot';
	const APPLY_PATHS: ApplyPath[] = ['delta', 'streaming snapshot', 'whole snapshot'];

	/** A fresh device that has received everything `from` holds, by one of the three apply paths. */
	async function freshDevice(from: Peer, name: string, path: ApplyPath): Promise<Peer> {
		const fresh = await peer(name);
		if (path === 'delta') await relayAll(from, fresh);
		else if (path === 'streaming snapshot') await fresh.manager.applySnapshotStream(toStream(await chunksOf(from)));
		else await fresh.manager.applySnapshot(await from.manager.getSnapshot());
		return fresh;
	}

	describe('announces the table as a baseline on the first fact it records', () => {
		const firstWrites: Array<{ kind: string; sql: string; rows: Array<{ id: number; v: string }> }> = [
			{ kind: 'insert', sql: `insert into extra values (2, 'two')`, rows: [{ id: 2, v: 'two' }] },
			{ kind: 'update', sql: `update extra set v = 'uno' where id = 1`, rows: [{ id: 1, v: 'uno' }] },
			{ kind: 'delete', sql: `delete from extra where id = 1`, rows: [] },
		];

		for (const { kind, sql, rows } of firstWrites) {
			it(`after a first ${kind}, a new device bootstraps by either snapshot path and holds what was recorded`, async () => {
				const d = await peer('d', { beforeSync: `${EXTRA}; insert into extra values (1, 'one')` });
				await localWrite(d, sql);

				expect(await migrationsOf(d)).to.deep.equal(['create_table extra@0']);
				for (const path of ['streaming snapshot', 'whole snapshot'] as const) {
					const fresh = await freshDevice(d, path, path);
					expect(columnsOf(fresh, 'extra'), path).to.deep.equal(['id', 'v']);
					expect(await collect(fresh.db, 'select id, v from extra order by id'), path).to.deep.equal(rows);
				}
			});
		}

		it('once, so a repeat write reads no migrations and announces nothing again', async () => {
			const d = await peer('d', { beforeSync: EXTRA });
			await localWrite(d, `insert into extra values (1, 'one')`);
			await localWrite(d, `insert into extra values (2, 'two')`);

			expect(await migrationsOf(d)).to.deep.equal(['create_table extra@0']);
		});
	});

	it('a connected device lacking the table receives the table and the row, with nothing quarantined', async () => {
		const d = await peer('d', { beforeSync: EXTRA });
		await localWrite(d, `insert into extra values (1, 'one')`);
		const c = await peer('c');

		const result = await relayAll(d, c);

		expect(result.unknownTable ?? 0).to.equal(0);
		expect(await collect(c.db, 'select id, v from extra')).to.deep.equal([{ id: 1, v: 'one' }]);
	});

	describe('a pre-sync table renamed under sync', () => {
		it('reaches a new device under its new name, and a device still holding the old name renames rather than conflicts', async () => {
			const d = await peer('d', { beforeSync: EXTRA });
			await localWrite(d, 'alter table extra rename to e2');
			await localWrite(d, `insert into e2 values (1, 'one')`);
			expect(await migrationsOf(d)).to.deep.equal(['rename_table e2@1', 'create_table e2@0']);

			const fresh = await freshDevice(d, 'fresh', 'streaming snapshot');
			expect(columnsOf(fresh, 'e2')).to.deep.equal(['id', 'v']);
			expect(columnsOf(fresh, 'extra')).to.equal(undefined);
			expect(await collect(fresh.db, 'select id, v from e2')).to.deep.equal([{ id: 1, v: 'one' }]);

			const old = await peer('old', { beforeSync: EXTRA });
			await relayAll(d, old);
			expect(columnsOf(old, 'extra')).to.equal(undefined);
			expect(await collect(old.db, 'select id, v from e2')).to.deep.equal([{ id: 1, v: 'one' }]);
		});

		it('in the same transaction as the first write is announced under the new name, after the rename', async () => {
			const d = await peer('d', { beforeSync: EXTRA });
			await d.db.exec('begin');
			await d.db.exec('alter table extra rename to e2');
			await d.db.exec(`insert into e2 values (1, 'one')`);
			await d.db.exec('commit');
			await settle();
			expect(await migrationsOf(d)).to.deep.equal(['rename_table e2@1', 'create_table e2@0']);

			const fresh = await freshDevice(d, 'fresh', 'delta');
			expect(await collect(fresh.db, 'select id, v from e2')).to.deep.equal([{ id: 1, v: 'one' }]);
		});
	});

	describe('shapes that differ between devices', () => {
		it('two devices with different pre-sync shapes exchange rows, each keeping its own shape', async () => {
			const a = await peer('a', { beforeSync: EXTRA });
			const b = await peer('b', { beforeSync: 'create table extra (id integer primary key, v text not null, more text) using store' });
			await localWrite(a, `insert into extra values (1, 'one')`);
			await localWrite(b, `insert into extra values (2, 'two', 'm')`);

			await relayAll(b, a);
			await relayAll(a, b);

			expect(columnsOf(a, 'extra')).to.deep.equal(['id', 'v']);
			expect(await collect(a.db, 'select id, v from extra order by id')).to.deep.equal([{ id: 1, v: 'one' }, { id: 2, v: 'two' }]);
			expect(columnsOf(b, 'extra')).to.deep.equal(['id', 'v', 'more']);
			expect(await collect(b.db, 'select id, v from extra order by id')).to.deep.equal([{ id: 1, v: 'one' }, { id: 2, v: 'two' }]);
		});

		it('an alteration crossing a baseline applies on both sides: no conflict, and the alteration is not lost', async () => {
			const a = await peer('a', { beforeSync: EXTRA });
			await localWrite(a, 'alter table extra add column note text null');
			const b = await peer('b', { beforeSync: EXTRA });
			await localWrite(b, `insert into extra values (1, 'one')`);

			await relayAll(b, a);
			expect(columnsOf(a, 'extra')).to.deep.equal(['id', 'v', 'note']);
			expect(await collect(a.db, 'select id, v from extra')).to.deep.equal([{ id: 1, v: 'one' }]);

			await relayAll(a, b);
			expect(columnsOf(b, 'extra'), 'the alteration reached the announcing device').to.deep.equal(['id', 'v', 'note']);
		});

		for (const path of APPLY_PATHS) {
			it(`a fresh device receiving an alteration and an older-shape baseline ends with the altered shape (${path})`, async () => {
				const a = await peer('a', { beforeSync: EXTRA });
				await localWrite(a, 'alter table extra add column note text null');
				const b = await peer('b', { beforeSync: EXTRA });
				await localWrite(b, `insert into extra values (1, 'one')`);
				// A relay holding both: the alteration (older) and the baseline (newer).
				const relay = await peer('relay');
				await relayAll(a, relay);
				await relayAll(b, relay);

				const fresh = await freshDevice(relay, 'fresh', path);

				expect(columnsOf(fresh, 'extra')).to.deep.equal(['id', 'v', 'note']);
				expect(await collect(fresh.db, 'select id, v from extra')).to.deep.equal([{ id: 1, v: 'one' }]);
			});
		}
	});

	for (const path of APPLY_PATHS) {
		it(`a table altered under sync before its first write replays on a fresh device without re-adding the column (${path})`, async () => {
			// The baseline carries the ALTERED shape and is ordered ahead of the alteration
			// it was recorded after, so the fresh device replays an add-column it already has.
			const d = await peer('d', { beforeSync: `${EXTRA}; insert into extra values (1, 'one')` });
			await localWrite(d, 'alter table extra add column note text null');
			await localWrite(d, `update extra set note = 'n' where id = 1`);
			expect(await migrationsOf(d)).to.deep.equal(['alter_column extra@1', 'create_table extra@0']);

			const fresh = await freshDevice(d, 'fresh', path);

			expect(columnsOf(fresh, 'extra')).to.deep.equal(['id', 'v', 'note']);
			expect(await collect(fresh.db, 'select id, v, note from extra')).to.deep.equal([{ id: 1, v: 'one', note: 'n' }]);
		});
	}

	it('a table one device dropped is not revived by a crossing baseline, on that device or on a fresh one', async () => {
		const a = await peer('a', { beforeSync: EXTRA });
		await localWrite(a, 'drop table extra');
		const b = await peer('b', { beforeSync: EXTRA });
		await localWrite(b, `insert into extra values (1, 'one')`);

		const onA = await relayAll(b, a);
		expect(columnsOf(a, 'extra'), 'the device that dropped it').to.equal(undefined);
		expect(onA.unknownTable ?? 0, 'its cells are held, not applied').to.be.greaterThan(0);

		// One batch carrying both, in either arrival order: the baseline must run ahead
		// of the drop, or the fresh device ends with a table every other device dropped.
		const fromA = await a.manager.getChangesSince(generateSiteId());
		const fromB = await b.manager.getChangesSince(generateSiteId());
		for (const [name, batch] of [['fresh', [...fromA, ...fromB]], ['fresh2', [...fromB, ...fromA]]] as Array<[string, ChangeSet[]]>) {
			const fresh = await peer(name);
			const result = await fresh.manager.applyChanges(batch);
			expect(columnsOf(fresh, 'extra'), name).to.equal(undefined);
			expect(result.unknownTable ?? 0, `${name}: cells held`).to.be.greaterThan(0);
		}
	});

	it('a baseline index runs on a table the baseline created, never on a device with its own table', async () => {
		const b = await peer('b', { beforeSync: `${EXTRA}; create unique index extra_v on extra (v)` });
		await localWrite(b, `insert into extra values (1, 'one')`);
		expect(await migrationsOf(b)).to.deep.equal(['create_table extra@0', 'add_index extra_v@0']);

		const fresh = await freshDevice(b, 'fresh', 'streaming snapshot');
		expect(indexesOf(fresh, 'extra')).to.deep.equal(['extra_v']);

		// A device whose own rows would violate the unique index keeps its table as it is.
		const a = await peer('a', { beforeSync: `${EXTRA}; insert into extra values (2, 'dup'), (3, 'dup')` });
		await relayAll(b, a);
		expect(indexesOf(a, 'extra')).to.deep.equal([]);
		expect(await collect(a.db, 'select id from extra order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it("a memory table's writes record nothing, so they neither strand a new device nor fail a peer's batch", async () => {
		const d = await peer('d', { beforeSync: 'create table scratch (id integer primary key) using memory' });
		await localWrite(d, 'create table later (id integer primary key) using memory');
		await localWrite(d, 'insert into scratch values (1)');
		await localWrite(d, 'insert into later values (1)');
		await localWrite(d, 'create table kept (id integer primary key) using store');
		await localWrite(d, 'insert into kept values (1)');

		const sets = await d.manager.getChangesSince(generateSiteId());
		expect(sets.flatMap(set => set.changes).map(change => change.table)).to.deep.equal(['kept']);

		// A peer declaring the same memory table applies the batch; a new device bootstraps.
		const c = await peer('c', { beforeSync: 'create table scratch (id integer primary key) using memory' });
		await localWrite(c, 'insert into scratch values (9)');
		await relayAll(d, c);
		expect(await collect(c.db, 'select id from kept')).to.deep.equal([{ id: 1 }]);
		expect(await collect(c.db, 'select id from scratch'), 'its own memory rows are untouched').to.deep.equal([{ id: 9 }]);

		const fresh = await freshDevice(d, 'fresh', 'streaming snapshot');
		expect(await collect(fresh.db, 'select id from kept')).to.deep.equal([{ id: 1 }]);
	});
});
