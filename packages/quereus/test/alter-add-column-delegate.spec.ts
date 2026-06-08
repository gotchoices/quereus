/**
 * Tests for the `delegatesNotNullBackfill` module capability.
 *
 * `runAddColumn` (runtime/emit/alter-table.ts) normally rejects
 * `ALTER TABLE … ADD COLUMN <NOT NULL, no usable DEFAULT>` on a non-empty
 * table via `validateNotNullBackfill`, BEFORE dispatching to the module. A
 * module that advertises `delegatesNotNullBackfill` opts out of that
 * engine-generic rejection so the decision is owned entirely by its
 * `alterTable`. Native modules leave the flag off, so their (and Quereus's
 * own) behavior is unchanged. Because APPLY SCHEMA re-executes generated DDL
 * through the same `emitAlterTable` path, the capability covers it too.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import { buildColumnIndexMap } from '../src/schema/table.js';
import type { SchemaChangeInfo } from '../src/vtab/module.js';
import type { ModuleCapabilities } from '../src/vtab/capabilities.js';
import type { ColumnDef } from '../src/parser/ast.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * A structurally-total memory module. It advertises
 * `delegatesNotNullBackfill` and, for ADD COLUMN, carries pre-existing rows
 * forward (backfilling NULL) rather than rejecting a NOT NULL add on a
 * non-empty table. It relaxes the column to nullable when delegating to the
 * base manager (so the manager's own backfill doesn't reject), then presents
 * the declared NOT NULL shape in the returned schema — modelling a module
 * that enforces NOT NULL at write time going forward.
 */
class TotalMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), delegatesNotNullBackfill: true };
	}

	override async alterTable(
		db: DatabaseType,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema> {
		if (change.type !== 'addColumn') {
			return super.alterTable(db, schemaName, tableName, change);
		}

		const declaredNotNull = (change.columnDef.constraints ?? []).some(c => c.type === 'notNull');
		const hasDefault = (change.columnDef.constraints ?? []).some(c => c.type === 'default');

		// Relax NOT NULL (with no DEFAULT) to nullable so the base manager
		// backfills NULL into existing rows instead of rejecting.
		const relaxedColumnDef: ColumnDef = (declaredNotNull && !hasDefault)
			? {
				...change.columnDef,
				constraints: [
					...(change.columnDef.constraints ?? []).filter(c => c.type !== 'notNull'),
					{ type: 'null' },
				],
			}
			: change.columnDef;

		const schema = await super.alterTable(db, schemaName, tableName, {
			type: 'addColumn',
			columnDef: relaxedColumnDef,
		});

		if (!declaredNotNull || hasDefault) return schema;

		// Present the declared NOT NULL shape (enforced at write time going forward).
		const newName = change.columnDef.name.toLowerCase();
		const cols = schema.columns.map(c =>
			c.name.toLowerCase() === newName ? { ...c, notNull: true } : c
		);
		return Object.freeze({
			...schema,
			columns: Object.freeze(cols),
			columnIndexMap: buildColumnIndexMap(cols),
		});
	}
}

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

describe('ALTER TABLE ADD COLUMN NOT NULL backfill delegation', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	it('native module still rejects NOT NULL ADD COLUMN on a non-empty table', async () => {
		db = new Database();
		// Default 'memory' module does not advertise the capability.
		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1), (2)`);

		let err: Error | undefined;
		try {
			await db.exec(`alter table t add column required text not null`);
		} catch (e) {
			err = e as Error;
		}
		expect(err, 'expected NOT NULL backfill rejection').to.exist;
		// The substrings the sqllogic conformance suite (41-alter-table) checks.
		expect(err!.message).to.match(/NOT NULL/);
	});

	it('delegating module: engine skips the check and ADD COLUMN succeeds', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1), (2)`);

		// Would be rejected engine-side for a native module; here it is delegated.
		await db.exec(`alter table t add column required text not null`);

		const table = db.schemaManager.getTable('main', 't');
		expect(table, 'table should still exist').to.exist;
		const col = table!.columns.find(c => c.name === 'required');
		expect(col, 'new column should be present').to.exist;
		expect(col!.notNull, 'column carries declared NOT NULL shape').to.equal(true);

		// Pre-existing rows are carried forward (backfilled NULL).
		const rows = await collect(db, `select id, required from t order by id`);
		expect(rows).to.deep.equal([
			{ id: 1, required: null },
			{ id: 2, required: null },
		]);
	});

	it('APPLY SCHEMA over a delegating module does not abort on NOT NULL ADD COLUMN', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		// Create a table with rows, then declare a wider schema and apply it.
		// The diff produces an ADD COLUMN <NOT NULL, no DEFAULT> against a
		// non-empty table — which must not abort the reconciliation.
		await db.exec(`create table users (id integer primary key, name text not null)`);
		await db.exec(`insert into users values (1, 'Alice'), (2, 'Bob')`);

		await db.exec(`
			declare schema main {
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					tier TEXT NOT NULL
				}
			}
		`);
		await db.exec(`apply schema main;`);

		const table = db.schemaManager.getTable('main', 'users');
		expect(table!.columns.map(c => c.name)).to.deep.equal(['id', 'name', 'tier']);

		const rows = await collect(db, `select id, name, tier from users order by id`);
		expect(rows).to.deep.equal([
			{ id: 1, name: 'Alice', tier: null },
			{ id: 2, name: 'Bob', tier: null },
		]);
	});
});
