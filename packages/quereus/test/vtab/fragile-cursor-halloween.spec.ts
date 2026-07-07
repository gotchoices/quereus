import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import {
	TestFragileCursorModule,
	setFragileData,
	getFragileRows,
	clearFragileStore,
} from './test-fragile-cursor-module.js';

/**
 * Regression coverage for the physical Halloween hazard: a predicate DELETE (or
 * UPDATE) that matches rows must fully separate its read phase from its write
 * phase, so it never mutates the b-tree its own scan cursor is still walking.
 *
 * Backed by `TestFragileCursorModule`, whose scan throws
 * `Path is invalid due to mutation of the tree` if the store is mutated mid-scan
 * — the failure mode reported against an `@optimystic/db-core` strand. The
 * memory vtab masks this bug (it snapshots reads onto an immutable layer); this
 * fixture does not, so it fails loudly until the executor drains the match set
 * before mutating.
 *
 * SKIPPED until the executor fix lands. This spec is the reproducing/regression
 * case for ticket `fix-halloween-predicate-dml-scan-cursor`. Confirmed to fail
 * (5 of 6) against HEAD with `Path is invalid due to mutation of the tree`; the
 * lone passing case is the zero-match control. The implement stage flips
 * `describe.skip` back to `describe`.
 */
describe.skip('predicate DELETE/UPDATE does not invalidate its own scan cursor (Halloween)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('fragile', new TestFragileCursorModule());
		clearFragileStore();
	});

	afterEach(async () => {
		await db.close();
	});

	async function evalRows(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
		const rows: Record<string, SqlValue>[] = [];
		for await (const r of db.eval(sql, params)) {
			rows.push(r as Record<string, SqlValue>);
		}
		return rows;
	}

	it('PK-prefix predicate DELETE removes matching rows (composite PK)', async () => {
		await db.exec(`create table lei (
			entry_id text,
			item_id text,
			constraint pk primary key (entry_id, item_id)
		) using fragile`);
		setFragileData('main', 'lei', [
			['e1', 'i1'],
			['e1', 'i2'],
			['e2', 'i9'],
		]);

		await db.exec("delete from lei where entry_id = 'e1'");

		const remaining = getFragileRows('main', 'lei');
		expect(remaining.map(r => r[1]).sort()).to.deep.equal(['i9']);
	});

	it('non-PK column predicate DELETE removes matching rows (single PK)', async () => {
		await db.exec(`create table iq (
			id text primary key,
			item_id text
		) using fragile`);
		setFragileData('main', 'iq', [
			['q1', 'a'],
			['q2', 'a'],
			['q3', 'b'],
		]);

		await db.exec("delete from iq where item_id = 'a'");

		const remaining = getFragileRows('main', 'iq');
		expect(remaining.map(r => r[0]).sort()).to.deep.equal(['q3']);
	});

	it('predicate UPDATE rewrites matching rows without cursor invalidation', async () => {
		await db.exec(`create table iq2 (
			id text primary key,
			item_id text,
			qty integer
		) using fragile`);
		setFragileData('main', 'iq2', [
			['q1', 'a', 1],
			['q2', 'a', 1],
			['q3', 'b', 1],
		]);

		await db.exec("update iq2 set qty = 5 where item_id = 'a'");

		const rows = getFragileRows('main', 'iq2');
		const byId = new Map(rows.map(r => [r[0], r[2]]));
		expect(byId.get('q1')).to.equal(5);
		expect(byId.get('q2')).to.equal(5);
		expect(byId.get('q3')).to.equal(1);
	});

	it('delete-then-reinsert the children of an existing parent within one transaction', async () => {
		await db.exec(`create table lei2 (
			entry_id text,
			item_id text,
			constraint pk primary key (entry_id, item_id)
		) using fragile`);
		setFragileData('main', 'lei2', [
			['e1', 'i1'],
			['e1', 'i2'],
		]);

		await db.exec('begin');
		await db.exec("delete from lei2 where entry_id = 'e1'");
		await db.exec("insert into lei2 (entry_id, item_id) values ('e1', 'i3')");
		await db.exec("insert into lei2 (entry_id, item_id) values ('e1', 'i4')");
		await db.exec('commit');

		const rows = getFragileRows('main', 'lei2');
		expect(rows.filter(r => r[0] === 'e1').map(r => r[1]).sort()).to.deep.equal(['i3', 'i4']);
	});

	it('DELETE matching zero rows still succeeds (control — nothing mutated)', async () => {
		await db.exec(`create table lei3 (
			entry_id text,
			item_id text,
			constraint pk primary key (entry_id, item_id)
		) using fragile`);
		setFragileData('main', 'lei3', [['e1', 'i1']]);

		await db.exec("delete from lei3 where entry_id = 'nope'");

		expect(getFragileRows('main', 'lei3')).to.have.length(1);
	});

	it('DELETE ... RETURNING yields deleted rows and clears them', async () => {
		await db.exec(`create table lei4 (
			entry_id text,
			item_id text,
			constraint pk primary key (entry_id, item_id)
		) using fragile`);
		setFragileData('main', 'lei4', [
			['e1', 'i1'],
			['e1', 'i2'],
		]);

		const returned = await evalRows("delete from lei4 where entry_id = 'e1' returning item_id");
		expect(returned.map(r => r.item_id).sort()).to.deep.equal(['i1', 'i2']);
		expect(getFragileRows('main', 'lei4')).to.have.length(0);
	});
});
