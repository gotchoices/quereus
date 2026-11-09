/**
 * The memory module reads `PredicateConstraint.collation`: an equality coarser than the
 * index column neither seeks the index nor pins its column for an ordering claim, so the
 * planner is never offered a plan its own collation checks would reject.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { BestAccessPlanResult, ColumnMeta, PredicateConstraint } from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';

function columnsOf(table: TableSchema): ColumnMeta[] {
	return table.columns.map((col, index) => ({
		index,
		name: col.name,
		type: col.logicalType,
		isPrimaryKey: col.primaryKey || false,
		isUnique: col.primaryKey || false,
	}));
}

describe('memory module access plans read the predicate collation', () => {
	const B = 1;
	const C = 2;
	let db: Database;
	let module: MemoryTableModule;

	/** `b = 'x'` under `collation`, ordered by `c`, over `t` with a BINARY `idx_bc(b, c)`. */
	function planFor(collation: string): BestAccessPlanResult {
		const table = db.schemaManager.getTable('main', 't')!;
		const filter: PredicateConstraint = { columnIndex: B, op: '=', value: 'x', usable: true, collation };
		return module.getBestAccessPlan(db, table, {
			columns: columnsOf(table),
			filters: [filter],
			requiredOrdering: [{ columnIndex: C, desc: false }],
			estimatedRows: 1000,
		});
	}

	beforeEach(async () => {
		db = new Database();
		module = new MemoryTableModule();
		await db.exec('create table t (id integer primary key, b text, c text) using memory');
		await db.exec('create index idx_bc on t(b, c)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('neither seeks nor claims ordering for a NOCASE equality over a BINARY index', () => {
		const plan = planFor('NOCASE');
		expect(plan.handledFilters[0]).to.equal(false);
		expect(plan.providesOrdering).to.equal(undefined);
	});

	it('seeks and claims ordering on the next key column for a BINARY equality', () => {
		const plan = planFor('BINARY');
		expect(plan.handledFilters[0]).to.equal(true);
		expect(plan.indexName).to.equal('idx_bc');
		expect(plan.providesOrdering).to.deep.equal([{ columnIndex: C, desc: false }]);
	});

	it('offers only the prefix seek when a BINARY prefix equality over a NOCASE index precedes a range', async () => {
		// The engine's prefix-range arm checks prefix keys as range bounds (exact collation
		// only), so claiming the trailing range here would get the seek declined to a scan.
		await db.exec('create table n (id integer primary key, b text collate nocase, c integer) using memory');
		await db.exec('create index idx_n_bc on n(b, c)');
		const table = db.schemaManager.getTable('main', 'n')!;
		const plan = module.getBestAccessPlan(db, table, {
			columns: columnsOf(table),
			filters: [
				{ columnIndex: B, op: '=', value: 'x', usable: true, collation: 'BINARY' },
				{ columnIndex: C, op: '>', value: 5, usable: true, collation: 'BINARY' },
			],
			estimatedRows: 1000,
		});
		expect(plan.indexName).to.equal('idx_n_bc');
		expect(plan.handledFilters).to.deep.equal([true, false]);
	});
});
