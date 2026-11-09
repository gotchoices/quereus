/**
 * A merged read stays correct when the module beneath the isolation layer honours
 * `FilterInfo.requiredColumns` (docs/module-authoring.md § "Required columns").
 *
 * The plan names only the columns it reads, but the merge also reads each stored row's
 * primary key (to drop the rows the transaction shadows) and, on a secondary-index walk,
 * its index key (to interleave the staged rows). `IsolatedTable` adds both before it
 * forwards the field; a module that then nulled them would leak shadowed rows and
 * misplace staged ones. The double nulls every unlisted column, as a column store may,
 * and records what it was asked for so neither case passes on an unnarrowed read.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule } from '@quereus/quereus';
import type { BaseModuleConfig, FilterInfo, Row, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

class ColumnDroppingMemoryModule extends MemoryTableModule {
	/** Column-name sets the module's `query()` was asked to fill, in call order. */
	readonly requested: string[][] = [];
	private readonly wrapped = new WeakSet<object>();

	private honourRequiredColumns<T extends { tableSchema?: TableSchema; query: (fi: FilterInfo) => AsyncIterable<Row> }>(table: T): T {
		if (this.wrapped.has(table)) return table;
		this.wrapped.add(table);
		const original = table.query.bind(table);
		const requested = this.requested;
		table.query = async function* (filterInfo: FilterInfo): AsyncIterable<Row> {
			const required = filterInfo.requiredColumns;
			if (required) {
				requested.push((table.tableSchema?.columns ?? []).filter((_, i) => required.has(i)).map(c => c.name));
			}
			for await (const row of original(filterInfo)) {
				yield required ? row.map((value, i) => (required.has(i) ? value : null)) : row;
			}
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema) {
		return this.honourRequiredColumns(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: BaseModuleConfig,
		tableSchema?: TableSchema,
	) {
		return this.honourRequiredColumns(
			await super.connect(db, pAux, moduleName, schemaName, tableName, options as never, tableSchema));
	}
}

describe('merged reads over a module that drops unread columns', () => {
	let db: Database;
	let underlying: ColumnDroppingMemoryModule;

	const column = async (sql: string): Promise<unknown[]> => {
		const out: unknown[] = [];
		for await (const row of db.eval(sql)) out.push(row.a);
		return out;
	};

	beforeEach(async () => {
		db = new Database();
		underlying = new ColumnDroppingMemoryModule();
		db.registerModule('isolated', new IsolationModule({ underlying }));
		await db.exec('create table t (id integer primary key, a integer, b integer) using isolated');
		await db.exec('create index t_b on t (b)');
		await db.exec('insert into t values (1, 10, 1), (2, 20, 3)');
		await db.exec('begin');
	});

	afterEach(async () => {
		await db.exec('rollback');
		await db.close();
	});

	it('keeps the primary key the merge shadows staged rows by', async () => {
		await db.exec('update t set a = 99 where id = 1');
		underlying.requested.length = 0;
		expect(await column('select a from t')).to.deep.equal([99, 20]);
		expect(underlying.requested, 'the stored rows were read narrowed').to.deep.equal([['id', 'a']]);
	});

	it('keeps the index key the merge interleaves staged rows by', async () => {
		await db.exec('insert into t values (3, 30, 2)');
		underlying.requested.length = 0;
		expect(await column('select a from t where b > 0 order by b')).to.deep.equal([10, 30, 20]);
		expect(underlying.requested, 'the stored rows were read narrowed').to.deep.equal([['id', 'a', 'b']]);
	});
});
