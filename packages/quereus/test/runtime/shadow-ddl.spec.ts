/**
 * Unit coverage for `buildShadowTableDdl` — the pure helper that emits the
 * CREATE TABLE string used by the non-memory ALTER TABLE rebuild path.
 *
 * This path only fires for non-MemoryTable modules (e.g. IsolationModule /
 * StoreModule in the IndexedDB / LevelDB plugins), so exercising it
 * end-to-end requires a downstream plugin. The DDL emitter itself is pure,
 * so we test it directly against real TableSchemas built via SQL.
 */

import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { buildShadowTableDdl } from '../../src/runtime/emit/alter-table.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../src/schema/table.js';

function pkOf(table: TableSchema): PrimaryKeyColumnDefinition[] {
	return [...(table.primaryKeyDefinition ?? [])];
}

describe('buildShadowTableDdl', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('emits explicit "null" for nullable columns', async () => {
		await db.exec(`create table t (id integer primary key, note text null)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.match(/\bnote\s+TEXT\s+null\b/);
		expect(ddl).to.match(/\bid\s+INTEGER\s+not null\b/);
	});

	it('emits explicit "not null" for non-null columns', async () => {
		await db.exec(`create table t (id integer primary key, n integer not null)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.match(/\bn\s+INTEGER\s+not null\b/);
	});

	it('preserves DEFAULT expressions through shadow rebuild', async () => {
		await db.exec(`create table t (id integer primary key, rate real default 1.0)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.match(/\brate\s+REAL\s+not null\s+default\s+1/i);
	});

	it('preserves COLLATE clause for non-BINARY collations', async () => {
		await db.exec(`create table t (id integer primary key, name text not null collate NOCASE)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.match(/collate\s+NOCASE/);
	});

	it('omits COLLATE for BINARY (default) collation', async () => {
		await db.exec(`create table t (id integer primary key, name text not null)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.not.match(/collate/i);
	});

	it('emits composite PRIMARY KEY clause', async () => {
		await db.exec(`create table t (a integer not null, b integer not null, c text null, primary key (a, b))`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(
			table,
			't__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		expect(ddl).to.match(/primary key \(a, b\)/i);
	});

	it('omits PRIMARY KEY clause when newPkDef is empty', async () => {
		await db.exec(`create table t (a integer not null, b text null, primary key ())`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', table.columns.map(c => c.name), []);

		expect(ddl).to.not.match(/primary key/i);
		// Nullability must still be annotated on every column:
		expect(ddl).to.match(/\ba\s+INTEGER\s+not null\b/);
		expect(ddl).to.match(/\bb\s+TEXT\s+null\b/);
	});

	it('re-executes to a schema that matches nullability, default, and collation of the source', async () => {
		await db.exec(`create table src (
			id integer primary key,
			note text null,
			rate real default 1.0,
			tag text not null collate NOCASE
		)`);
		const table = db.schemaManager.getTable('main', 'src')!;

		const ddl = buildShadowTableDdl(
			table,
			'src__rekey_1',
			table.columns.map(c => c.name),
			pkOf(table),
		);

		const db2 = new Database();
		try {
			await db2.exec(ddl);
			const rebuilt = db2.schemaManager.getTable('main', 'src__rekey_1')!;
			const byName = new Map(rebuilt.columns.map(c => [c.name, c]));

			expect(byName.get('note')!.notNull, 'note stays nullable').to.equal(false);
			expect(byName.get('id')!.notNull, 'id stays NOT NULL').to.equal(true);
			expect(byName.get('rate')!.defaultValue, 'rate default survives').to.not.equal(null);
			expect(byName.get('tag')!.collation, 'tag collation survives').to.equal('NOCASE');
		} finally {
			await db2.close();
		}
	});
});
