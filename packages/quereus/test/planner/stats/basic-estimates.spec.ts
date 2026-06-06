import { expect } from 'chai';
import { BasicRowEstimator, getRowEstimate, ensureRowEstimate } from '../../../src/planner/stats/basic-estimates.js';
import type { OptimizerTuning } from '../../../src/planner/optimizer-tuning.js';
import type { RelationalPlanNode } from '../../../src/planner/nodes/plan-node.js';

const tuning = { defaultRowEstimate: 1000 } as OptimizerTuning;
const est = new BasicRowEstimator(tuning);

describe('BasicRowEstimator', () => {

	// ── estimateFilter ──────────────────────────────────────────────────

	describe('estimateFilter', () => {
		it('applies 30% selectivity', () => {
			expect(est.estimateFilter(100)).to.equal(30);
		});

		it('floors at 1 row', () => {
			expect(est.estimateFilter(0)).to.equal(1);
			expect(est.estimateFilter(1)).to.equal(1);
			expect(est.estimateFilter(2)).to.equal(1);
		});

		it('floors fractional results', () => {
			// 3 * 0.3 = 0.9 → Math.floor → 0 → Math.max(1, 0) → 1
			expect(est.estimateFilter(3)).to.equal(1);
			// 10 * 0.3 = 3.0 → 3
			expect(est.estimateFilter(10)).to.equal(3);
		});

		it('scales linearly for large inputs', () => {
			expect(est.estimateFilter(10000)).to.equal(3000);
		});
	});

	// ── estimateJoin ────────────────────────────────────────────────────

	describe('estimateJoin', () => {
		it('inner join applies 10% correlation', () => {
			// 100 * 200 * 0.1 = 2000
			expect(est.estimateJoin(100, 200, 'inner')).to.equal(2000);
		});

		it('inner join floors at 1 row', () => {
			expect(est.estimateJoin(0, 0, 'inner')).to.equal(1);
		});

		it('inner join is case-insensitive', () => {
			expect(est.estimateJoin(100, 200, 'INNER')).to.equal(2000);
			expect(est.estimateJoin(100, 200, 'Inner')).to.equal(2000);
		});

		it('left join never goes below left side', () => {
			expect(est.estimateJoin(100, 5, 'left')).to.equal(100);
		});

		it('left join uses correlation when larger', () => {
			// 100 * 200 * 0.1 = 2000 > 100
			expect(est.estimateJoin(100, 200, 'left')).to.equal(2000);
		});

		it('left outer join behaves same as left', () => {
			expect(est.estimateJoin(100, 5, 'left outer')).to.equal(100);
			expect(est.estimateJoin(100, 200, 'left outer')).to.equal(2000);
		});

		it('right join never goes below right side', () => {
			expect(est.estimateJoin(5, 100, 'right')).to.equal(100);
		});

		it('right join uses correlation when larger', () => {
			// 200 * 100 * 0.1 = 2000 > 100
			expect(est.estimateJoin(200, 100, 'right')).to.equal(2000);
		});

		it('right outer join behaves same as right', () => {
			expect(est.estimateJoin(5, 100, 'right outer')).to.equal(100);
			expect(est.estimateJoin(200, 100, 'right outer')).to.equal(2000);
		});

		it('full outer join never falls below max(left, right)', () => {
			// Heuristic would yield 300 - 2000 = -1700; clamped to max(100, 200) = 200.
			expect(est.estimateJoin(100, 200, 'full')).to.equal(200);
		});

		it('full outer alias behaves same as full', () => {
			expect(est.estimateJoin(100, 200, 'full outer')).to.equal(200);
		});

		it('full outer with small tables uses sum minus overlap', () => {
			// 3 + 5 - floor(3 * 5 * 0.1) = 8 - 1 = 7 (already >= max(3, 5))
			expect(est.estimateJoin(3, 5, 'full')).to.equal(7);
		});

		it('cross join produces exact cartesian product', () => {
			expect(est.estimateJoin(7, 11, 'cross')).to.equal(77);
		});

		it('cross join with zero returns zero', () => {
			expect(est.estimateJoin(0, 100, 'cross')).to.equal(0);
		});

		it('default case returns max of both sides', () => {
			expect(est.estimateJoin(50, 200, 'natural')).to.equal(200);
			expect(est.estimateJoin(300, 100, 'semi')).to.equal(300);
		});
	});

	// ── estimateAggregate ───────────────────────────────────────────────

	describe('estimateAggregate', () => {
		it('scalar aggregate (groupByCount=0) returns 1', () => {
			expect(est.estimateAggregate(100, 0)).to.equal(1);
			expect(est.estimateAggregate(0, 0)).to.equal(1);
		});

		it('single group-by uses 0.2 factor, clamped to [0.1, 0.8]', () => {
			// groupByCount=1 → factor = min(0.8, max(0.1, 1*0.2)) = 0.2
			// floor(100 * 0.2) = 20
			expect(est.estimateAggregate(100, 1)).to.equal(20);
		});

		it('multiple group-by columns increase grouping factor', () => {
			// groupByCount=3 → factor = min(0.8, max(0.1, 3*0.2)) = min(0.8, 0.6) = 0.6
			// floor(100 * 0.6) = 60
			expect(est.estimateAggregate(100, 3)).to.equal(60);
		});

		it('grouping factor is clamped at 0.8', () => {
			// groupByCount=5 → factor = min(0.8, max(0.1, 5*0.2)) = min(0.8, 1.0) = 0.8
			expect(est.estimateAggregate(100, 5)).to.equal(80);
			// groupByCount=10 → same cap
			expect(est.estimateAggregate(100, 10)).to.equal(80);
		});

		it('floors at 1 row', () => {
			expect(est.estimateAggregate(1, 1)).to.equal(1);
		});
	});

	// ── estimateDistinct ────────────────────────────────────────────────

	describe('estimateDistinct', () => {
		it('assumes 70% unique rows', () => {
			expect(est.estimateDistinct(100)).to.equal(70);
		});

		it('floors at 1 row', () => {
			expect(est.estimateDistinct(0)).to.equal(1);
			expect(est.estimateDistinct(1)).to.equal(1);
		});

		it('scales linearly', () => {
			expect(est.estimateDistinct(1000)).to.equal(700);
		});
	});

	// ── estimateLimit ───────────────────────────────────────────────────

	describe('estimateLimit', () => {
		it('returns limit when source has more rows', () => {
			expect(est.estimateLimit(1000, 10)).to.equal(10);
		});

		it('returns source rows when limit exceeds source', () => {
			expect(est.estimateLimit(5, 100)).to.equal(5);
		});

		it('subtracts offset from limit', () => {
			// min(1000, max(0, 50 - 10)) = 40
			expect(est.estimateLimit(1000, 50, 10)).to.equal(40);
		});

		it('offset exceeding limit returns 0', () => {
			expect(est.estimateLimit(1000, 10, 20)).to.equal(0);
		});

		it('zero source rows returns 0', () => {
			expect(est.estimateLimit(0, 10)).to.equal(0);
		});

		it('zero limit returns 0', () => {
			expect(est.estimateLimit(100, 0)).to.equal(0);
		});

		it('defaults offset to 0', () => {
			expect(est.estimateLimit(100, 10)).to.equal(10);
		});
	});

	// ── getDefaultEstimate ──────────────────────────────────────────────

	describe('getDefaultEstimate', () => {
		it('returns tuning defaultRowEstimate', () => {
			expect(est.getDefaultEstimate()).to.equal(1000);
		});

		it('reflects custom tuning value', () => {
			const custom = new BasicRowEstimator({ defaultRowEstimate: 42 } as OptimizerTuning);
			expect(custom.getDefaultEstimate()).to.equal(42);
		});
	});
});

// ── getRowEstimate ──────────────────────────────────────────────────────

describe('getRowEstimate', () => {
	it('returns estimatedRows when set on node', () => {
		const node = { estimatedRows: 42 } as RelationalPlanNode;
		expect(getRowEstimate(node, tuning)).to.equal(42);
	});

	it('falls back to tuning default when estimatedRows is undefined', () => {
		const node = {} as RelationalPlanNode;
		expect(getRowEstimate(node, tuning)).to.equal(1000);
	});
});

// ── ensureRowEstimate ───────────────────────────────────────────────────

describe('ensureRowEstimate', () => {
	it('sets estimatedRows on node with undefined value', () => {
		const node = {} as RelationalPlanNode;
		ensureRowEstimate(node, 500);
		expect(node.estimatedRows).to.equal(500);
	});

	it('does not overwrite existing estimatedRows (idempotent)', () => {
		const node = {} as RelationalPlanNode;
		ensureRowEstimate(node, 500);
		ensureRowEstimate(node, 999);
		expect(node.estimatedRows).to.equal(500);
	});

	it('property is non-writable after being set', () => {
		const node = {} as RelationalPlanNode;
		ensureRowEstimate(node, 42);
		// ESM modules run in strict mode, so writing to a non-writable property throws.
		expect(() => { (node as { estimatedRows: number }).estimatedRows = 999; }).to.throw(TypeError);
		expect(node.estimatedRows).to.equal(42);
	});
});
