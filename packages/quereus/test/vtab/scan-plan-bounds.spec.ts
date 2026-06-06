import { expect } from 'chai';
import { IndexConstraintOp } from '../../src/common/constants.js';
import { buildScanPlanFromFilterInfo } from '../../src/vtab/memory/layer/scan-plan.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { IndexInfo, IndexConstraint } from '../../src/vtab/index-info.js';
import type { TableSchema } from '../../src/schema/table.js';

/**
 * Build a minimal FilterInfo for a range plan (plan=3) on a single-column
 * primary key, with the given constraints passed via the constraints array.
 */
function makeRangeFilterInfo(
	constraintDefs: { op: IndexConstraintOp; value: number }[],
): { filterInfo: FilterInfo; tableSchema: TableSchema } {
	const aConstraint: IndexConstraint[] = constraintDefs.map((c, i) => ({
		iColumn: 0,
		op: c.op,
		usable: true,
		iTermOffset: i,
	}));

	const constraints = constraintDefs.map((c, i) => ({
		constraint: aConstraint[i],
		argvIndex: i + 1,
	}));

	const args = constraintDefs.map(c => c.value);

	const indexInfoOutput: IndexInfo = {
		nConstraint: aConstraint.length,
		aConstraint,
		nOrderBy: 0,
		aOrderBy: [],
		colUsed: 1n,
		aConstraintUsage: aConstraint.map((_, i) => ({ argvIndex: i + 1, omit: false })),
		idxNum: 0,
		idxStr: null,
		orderByConsumed: false,
		estimatedCost: 100,
		estimatedRows: 100n,
		idxFlags: 0,
	};

	const filterInfo: FilterInfo = {
		idxNum: 0,
		idxStr: `plan=3;idx=_primary_(1);argvMap=${constraintDefs.map((_, i) => `[${i + 1},${i}]`).join('')}`,
		constraints,
		args,
		indexInfoOutput,
	};

	const tableSchema = {
		name: 'test',
		schemaName: 'main',
		columns: [{ name: 'id', index: 0 }],
		columnIndexMap: new Map([['id', 0]]),
		primaryKeyDefinition: [{ index: 0, desc: false }],
		checkConstraints: [],
		vtabModule: {},
		vtabModuleName: 'memory',
	} as unknown as TableSchema;

	return { filterInfo, tableSchema };
}

describe('scan-plan applyBound enum ordering', () => {
	describe('lower bound: GT should be preferred over GE (stricter exclusive bound)', () => {
		it('prefers GT when GT comes before GE', () => {
			const { filterInfo, tableSchema } = makeRangeFilterInfo([
				{ op: IndexConstraintOp.GT, value: 5 },
				{ op: IndexConstraintOp.GE, value: 5 },
			]);
			const plan = buildScanPlanFromFilterInfo(filterInfo, tableSchema);
			expect(plan.lowerBound).to.exist;
			expect(plan.lowerBound!.op).to.equal(IndexConstraintOp.GT,
				'GT (exclusive) should be preferred over GE (inclusive) for lower bound');
		});

		it('prefers GT when GE comes before GT', () => {
			const { filterInfo, tableSchema } = makeRangeFilterInfo([
				{ op: IndexConstraintOp.GE, value: 5 },
				{ op: IndexConstraintOp.GT, value: 5 },
			]);
			const plan = buildScanPlanFromFilterInfo(filterInfo, tableSchema);
			expect(plan.lowerBound).to.exist;
			expect(plan.lowerBound!.op).to.equal(IndexConstraintOp.GT,
				'GT (exclusive) should be preferred over GE (inclusive) for lower bound');
		});
	});

	describe('upper bound: LT should be preferred over LE (stricter exclusive bound)', () => {
		it('prefers LT when LT comes before LE', () => {
			const { filterInfo, tableSchema } = makeRangeFilterInfo([
				{ op: IndexConstraintOp.LT, value: 10 },
				{ op: IndexConstraintOp.LE, value: 10 },
			]);
			const plan = buildScanPlanFromFilterInfo(filterInfo, tableSchema);
			expect(plan.upperBound).to.exist;
			expect(plan.upperBound!.op).to.equal(IndexConstraintOp.LT,
				'LT (exclusive) should be preferred over LE (inclusive) for upper bound');
		});

		it('prefers LT when LE comes before LT', () => {
			const { filterInfo, tableSchema } = makeRangeFilterInfo([
				{ op: IndexConstraintOp.LE, value: 10 },
				{ op: IndexConstraintOp.LT, value: 10 },
			]);
			const plan = buildScanPlanFromFilterInfo(filterInfo, tableSchema);
			expect(plan.upperBound).to.exist;
			expect(plan.upperBound!.op).to.equal(IndexConstraintOp.LT,
				'LT (exclusive) should be preferred over LE (inclusive) for upper bound');
		});
	});

	describe('combined bounds: both directions with mixed ops', () => {
		it('selects GT for lower and LT for upper when all four ops present', () => {
			const { filterInfo, tableSchema } = makeRangeFilterInfo([
				{ op: IndexConstraintOp.GE, value: 3 },
				{ op: IndexConstraintOp.GT, value: 5 },
				{ op: IndexConstraintOp.LE, value: 20 },
				{ op: IndexConstraintOp.LT, value: 15 },
			]);
			const plan = buildScanPlanFromFilterInfo(filterInfo, tableSchema);
			expect(plan.lowerBound).to.exist;
			expect(plan.lowerBound!.op).to.equal(IndexConstraintOp.GT);
			expect(plan.lowerBound!.value).to.equal(5);
			expect(plan.upperBound).to.exist;
			expect(plan.upperBound!.op).to.equal(IndexConstraintOp.LT);
			expect(plan.upperBound!.value).to.equal(15);
		});
	});
});
