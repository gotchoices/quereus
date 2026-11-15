/**
 * Module-listed seek arguments (`BestAccessPlanResult.moduleSeekFilters`): the module lists
 * the filters it enforces inside its chosen index, and the engine hands it exactly those
 * filters' values, in list order, as `FilterInfo.args` (plan code 8). The access path of an
 * index the engine cannot describe, under a plan that claims no order, is `unorderedIndex`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { EmptyResultNode, IndexSeekNode, SeqScanNode } from '../../src/planner/nodes/table-access-nodes.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import type { SqlValue } from '../../src/common/types.js';
import {
	validateAccessPlan,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	type ColumnMeta,
	type PredicateConstraint,
} from '../../src/vtab/best-access-plan.js';
import { INTEGER_TYPE } from '../../src/types/index.js';
import { MODULE_SEEK_INDEX_NAME, TestModuleSeekModule, moduleSeekStore } from './test-module-seek-module.js';

/** Every node of the optimized plan for `sql`. */
function planNodes(db: Database, sql: string): PlanNode[] {
	const out: PlanNode[] = [];
	const walk = (n: PlanNode): void => {
		out.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(db.getPlan(sql));
	return out;
}

/** `{ id }` of every row `sql` returns, in result order. */
async function ids(db: Database, sql: string, params?: SqlValue[]): Promise<number[]> {
	const out: number[] = [];
	const stmt = db.prepare(sql);
	try {
		for await (const row of stmt.all(params)) out.push(Number(row.id));
	} finally {
		await stmt.finalize();
	}
	return out;
}

describe('module-listed seek arguments (moduleSeekFilters)', () => {
	let db: Database;
	let module: TestModuleSeekModule;

	beforeEach(async () => {
		moduleSeekStore.clear();
		db = new Database();
		module = new TestModuleSeekModule();
		db.registerModule('module_seek', module);
		await db.exec('create table t (id integer primary key, x integer, y integer, z integer, name text collate nocase) using module_seek');
		await db.exec(`insert into t values
			(1, 1, 1, 1, 'bob'), (2, 2, 4, 1, 'BOB'), (3, 3, 3, 0, 'alice'), (4, 5, 2, 1, 'carol'), (5, 4, 5, 1, 'dave')`);
		module.listedColumns = new Set([1, 2]);
	});

	afterEach(async () => {
		await db.close();
	});

	it('delivers a placeholder box as the listed constraints and arguments, per execution', async () => {
		// Spelled with comparisons: a `between` with non-literal bounds is not offered to modules yet.
		const sql = 'select id from t where x >= ? and x <= ? and y >= ? and y <= ? order by id';

		expect(await ids(db, sql, [1, 3, 1, 3])).to.deep.equal([1, 3]);
		expect(await ids(db, sql, [2, 5, 4, 6])).to.deep.equal([2, 5]);

		const fi = module.lastFilterInfo!;
		expect(fi.constraints.map(c => [c.constraint.iColumn, c.constraint.op])).to.deep.equal([
			[1, IndexConstraintOp.GE], [1, IndexConstraintOp.LE], [2, IndexConstraintOp.GE], [2, IndexConstraintOp.LE],
		]);
		expect(fi.args).to.deep.equal([2, 5, 4, 6]);
		expect(fi.idxStr).to.equal(`idx=${MODULE_SEEK_INDEX_NAME}(0);plan=8`);
		expect(fi.accessPath).to.deep.equal({ kind: 'unorderedIndex', indexName: MODULE_SEEK_INDEX_NAME, plan: 'moduleSeek' });

		const nodes = planNodes(db, sql);
		expect(nodes.some(n => n instanceof IndexSeekNode)).to.be.true;
		expect(nodes.some(n => n instanceof FilterNode), 'every listed filter is enforced by the module').to.be.false;
	});

	it('re-checks a handled filter the module did not list, and only that one', async () => {
		module.unlistedColumn = 3;
		const sql = 'select id from t where x >= 2 and z = 1 order by id';
		// The module never receives `z = 1`, so the right answer proves the Filter re-checks it;
		// one Filter, with `x >= 2` delivered to the module, proves the listed one is not re-checked.
		expect(await ids(db, sql)).to.deep.equal([2, 4, 5]);
		expect(module.lastFilterInfo!.constraints.map(c => [c.constraint.iColumn, c.constraint.op]))
			.to.deep.equal([[1, IndexConstraintOp.GE]]);
		expect(module.lastFilterInfo!.args).to.deep.equal([2]);
		expect(planNodes(db, sql).filter(n => n instanceof FilterNode)).to.have.lengthOf(1);

		// An empty list still drives the module's own index, with no arguments.
		module.listNothing = true;
		expect(await ids(db, sql)).to.deep.equal([2, 4, 5]);
		expect(module.lastFilterInfo!.idxStr).to.equal(`idx=${MODULE_SEEK_INDEX_NAME}(0);plan=8`);
		expect(module.lastFilterInfo!.args).to.deep.equal([]);
	});

	it('folds a listed comparison with a literal NULL to an empty result without calling the module', async () => {
		// An equality: the extractor leaves `x > null` as a residual and never offers it.
		const sql = 'select id from t where x = null and y < 5';
		expect(planNodes(db, sql).some(n => n instanceof EmptyResultNode)).to.be.true;
		expect(await ids(db, sql)).to.deep.equal([]);
		expect(module.queryCount).to.equal(0);
	});

	it('declines to a scan with a residual when a listed filter is not BINARY on an undescribed index', async () => {
		module.listedColumns = new Set([4]);
		const sql = "select id from t where name = 'bob' order by id";
		const nodes = planNodes(db, sql);
		expect(nodes.some(n => n instanceof SeqScanNode)).to.be.true;
		expect(nodes.some(n => n instanceof IndexSeekNode)).to.be.false;
		expect(nodes.some(n => n instanceof FilterNode)).to.be.true;
		expect(await ids(db, sql)).to.deep.equal([1, 2]);
	});

	it('keeps the Sort when the arm will decline a described index the module claims an order from', async () => {
		// A NOCASE equality on a NOCASE key column matches under the equality lattice, but the
		// arm's range rule declines it (no honorsCollatedRangeBounds) to an unordered scan.
		module.listedColumns = new Set([4]);
		module.descriptor = {
			name: MODULE_SEEK_INDEX_NAME, role: 'secondary', unique: true,
			keyColumns: [{ columnIndex: 4, desc: false, collation: 'NOCASE' }, { columnIndex: 0, desc: false }],
		};
		expect(await ids(db, "select id from t where name = 'bob' order by id")).to.deep.equal([1, 2]);
	});

	describe('validateAccessPlan', () => {
		const columns: ColumnMeta[] = [0, 1].map(index => ({
			index, name: `c${index}`, type: INTEGER_TYPE, isPrimaryKey: index === 0, isUnique: index === 0,
		}));
		const filter = (op: PredicateConstraint['op'], extra: Partial<PredicateConstraint> = {}): PredicateConstraint =>
			({ columnIndex: 1, op, value: 1, usable: true, ...extra });
		const plan = (overrides: Partial<BestAccessPlanResult>): BestAccessPlanResult =>
			({ handledFilters: [true, true], cost: 1, rows: 1, indexName: '_box_', moduleSeekFilters: [0], ...overrides });
		const twoRanges = [filter('>'), filter('<')];

		const cases: { label: string; filters: PredicateConstraint[]; result: BestAccessPlanResult; error: RegExp }[] = [
			{ label: 'no indexName', filters: twoRanges, result: plan({ indexName: undefined }), error: /requires indexName/ },
			{ label: 'non-empty seekColumnIndexes', filters: twoRanges, result: plan({ seekColumnIndexes: [1] }), error: /mutually exclusive/ },
			{ label: 'out-of-range entry', filters: twoRanges, result: plan({ moduleSeekFilters: [2] }), error: /not an index/ },
			{ label: 'fractional entry', filters: twoRanges, result: plan({ moduleSeekFilters: [0.5] }), error: /not an index/ },
			{ label: 'repeated entry', filters: twoRanges, result: plan({ moduleSeekFilters: [0, 0] }), error: /more than once/ },
			{ label: 'unhandled filter', filters: twoRanges, result: plan({ handledFilters: [false, true] }), error: /does not claim/ },
			{ label: 'multi-value IN', filters: [filter('IN', { value: [1, 2] as unknown as SqlValue }), filter('<')], result: plan({}), error: /only =/ },
			{ label: 'runtime-set IN', filters: [filter('IN', { value: undefined, runtimeSet: { maxCount: 1 } }), filter('<')], result: plan({}), error: /only =/ },
			{ label: 'OR_RANGE', filters: [filter('OR_RANGE', { ranges: [] }), filter('<')], result: plan({}), error: /only =/ },
			{ label: 'IS NULL', filters: [filter('IS NULL'), filter('<')], result: plan({}), error: /only =/ },
			{ label: 'LIKE', filters: [filter('LIKE'), filter('<')], result: plan({}), error: /only =/ },
		];

		for (const { label, filters, result, error } of cases) {
			it(`rejects ${label}`, () => {
				const request: BestAccessPlanRequest = { columns, filters };
				expect(() => validateAccessPlan(request, result)).to.throw(error);
			});
		}

		it('accepts a single-value IN, an equality and an empty list', () => {
			const filters = [filter('IN', { value: [1] as unknown as SqlValue }), filter('=')];
			const request: BestAccessPlanRequest = { columns, filters };
			expect(() => validateAccessPlan(request, plan({ moduleSeekFilters: [0, 1] }))).to.not.throw();
			expect(() => validateAccessPlan(request, plan({ moduleSeekFilters: [] }))).to.not.throw();
		});
	});
});
