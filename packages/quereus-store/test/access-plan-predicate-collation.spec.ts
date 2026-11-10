/**
 * The store module reads `PredicateConstraint.collation`: an equality or range bound whose
 * collation the key column cannot serve neither seeks that key nor pins its column for an
 * ordering claim, so the planner is never offered a plan its own collation checks would
 * decline to a scan. The memory module's twin is `memory-access-plan-collation.spec.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	type BestAccessPlanResult,
	type OrderingSpec,
	type PredicateConstraint,
	type SqlValue,
} from '@quereus/quereus';
import { StoreModule, type KVStoreProvider } from '../src/index.js';
import { createInMemoryProvider } from '../src/testing/memory-provider.js';

const ID = 0;
const B = 1;
const C = 2;

function filter(columnIndex: number, op: PredicateConstraint['op'], value: SqlValue, collation: string): PredicateConstraint {
	return { columnIndex, op, value, usable: true, collation };
}

interface Case {
	readonly name: string;
	readonly table: string;
	readonly filters: readonly PredicateConstraint[];
	readonly requiredOrdering?: readonly OrderingSpec[];
	readonly indexName: string | undefined;
	readonly handled: readonly boolean[];
	readonly providesOrdering?: readonly OrderingSpec[];
}

const CASES: readonly Case[] = [
	// t(id, b text, c integer) with a BINARY ix_bc(b, c).
	{
		name: 'a NOCASE equality over a BINARY index neither seeks it nor claims ordering on the next column',
		table: 't', filters: [filter(B, '=', 'x', 'NOCASE')], requiredOrdering: [{ columnIndex: C, desc: false }],
		indexName: undefined, handled: [false], providesOrdering: undefined,
	},
	{
		name: 'a BINARY equality over a BINARY index seeks it and claims ordering on the next column',
		table: 't', filters: [filter(B, '=', 'x', 'BINARY')], requiredOrdering: [{ columnIndex: C, desc: false }],
		indexName: 'ix_bc', handled: [true], providesOrdering: [{ columnIndex: C, desc: false }],
	},
	{
		name: 'a NOCASE range bound over a BINARY index is not walked',
		table: 't', filters: [filter(B, '>', 'm', 'NOCASE')],
		indexName: undefined, handled: [false],
	},
	{
		name: 'a BINARY range bound over a BINARY index is walked',
		table: 't', filters: [filter(B, '>', 'm', 'BINARY')],
		indexName: 'ix_bc', handled: [true],
	},
	{
		name: 'a range beside an equality the index cannot serve is not offered either',
		table: 't', filters: [filter(B, '=', 'x', 'NOCASE'), filter(B, '>', 'a', 'BINARY')],
		indexName: undefined, handled: [false, false],
	},
	// u(id, a integer, b text) with a BINARY ix_ab(a, b): the trailing bound of a prefix-range.
	{
		name: 'a prefix-range whose trailing bound fails keeps the equality-prefix seek',
		table: 'u', filters: [filter(B, '=', 1, 'BINARY'), filter(C, '>', 'm', 'NOCASE')],
		indexName: 'ix_ab', handled: [true, false],
	},
	// n(id, b text collate nocase, c integer) with ix_n_bc(b, c), NOCASE on b.
	{
		name: 'a BINARY prefix equality over a NOCASE key column keeps only the prefix seek',
		table: 'n', filters: [filter(B, '=', 'x', 'BINARY'), filter(C, '>', 5, 'BINARY')],
		indexName: 'ix_n_bc', handled: [true, false],
	},
	// p(id text primary key, v integer): the text key takes the store's default key collation, NOCASE.
	{
		name: 'an RTRIM equality on a NOCASE text primary key is no point lookup',
		table: 'p', filters: [filter(ID, '=', 'x', 'RTRIM')],
		indexName: undefined, handled: [false],
	},
	{
		name: 'a NOCASE equality on a NOCASE text primary key is a point lookup',
		table: 'p', filters: [filter(ID, '=', 'x', 'NOCASE')],
		indexName: '_primary_', handled: [true],
	},
	{
		name: 'a BINARY equality on a NOCASE text primary key is a point lookup (the engine adds a residual)',
		table: 'p', filters: [filter(ID, '=', 'X', 'BINARY')],
		indexName: '_primary_', handled: [true],
	},
	{
		name: 'an RTRIM range bound on a NOCASE text primary key is no primary-key range',
		table: 'p', filters: [filter(ID, '>', 'm', 'RTRIM')],
		indexName: undefined, handled: [false],
	},
	{
		name: 'a NOCASE range bound on a NOCASE text primary key is a primary-key range',
		table: 'p', filters: [filter(ID, '>', 'm', 'NOCASE')],
		indexName: '_primary_', handled: [true],
	},
];

describe('store module access plans read the predicate collation', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	function planFor(c: Case): BestAccessPlanResult {
		const table = db.schemaManager.getTable('main', c.table);
		expect(table, `table ${c.table} should exist`).to.exist;
		return storeModule.getBestAccessPlan(db, table!, {
			columns: table!.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false,
			})),
			filters: [...c.filters],
			requiredOrdering: c.requiredOrdering ? [...c.requiredOrdering] : undefined,
			estimatedRows: 1000,
		});
	}

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
		await db.exec('create table t (id integer primary key, b text, c integer) using store');
		await db.exec('create index ix_bc on t (b, c)');
		await db.exec('create table u (id integer primary key, a integer, b text) using store');
		await db.exec('create index ix_ab on u (a, b)');
		await db.exec('create table n (id integer primary key, b text collate nocase, c integer) using store');
		await db.exec('create index ix_n_bc on n (b, c)');
		await db.exec('create table p (id text primary key, v integer) using store');
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	for (const c of CASES) {
		it(c.name, () => {
			const plan = planFor(c);
			expect(plan.indexName, 'index').to.equal(c.indexName);
			expect(plan.handledFilters, 'handled filters').to.deep.equal(c.handled);
			if ('providesOrdering' in c) {
				expect(plan.providesOrdering, 'ordering claim').to.deep.equal(c.providesOrdering);
			}
		});
	}
});
