import { expect } from 'chai';
import {
	seqScanCost,
	indexSeekCost,
	indexScanCost,
	sortCost,
	filterCost,
	projectCost,
	aggregateCost,
	hashAggregateCost,
	streamAggregateCost,
	nestedLoopJoinCost,
	mergeJoinCost,
	hashJoinCost,
	distinctCost,
	limitCost,
	cacheCost,
	chooseCheapest,
} from '../../src/planner/cost/index.js';

/** Assert a value is a finite non-negative number */
function expectValidCost(value: number, label?: string): void {
	expect(value, label).to.be.a('number');
	expect(Number.isFinite(value), `${label ?? 'cost'} should be finite (got ${value})`).to.be.true;
	expect(value, label).to.be.at.least(0);
}

describe('Cost model', () => {

	// ─── Individual cost functions: boundary and monotonicity ───────────

	interface UnaryFn { (rows: number): number }

	const unaryCostFns: Array<{ name: string; fn: UnaryFn }> = [
		{ name: 'seqScanCost', fn: seqScanCost },
		{ name: 'indexSeekCost', fn: indexSeekCost },
		{ name: 'indexScanCost', fn: indexScanCost },
		{ name: 'sortCost', fn: sortCost },
		{ name: 'filterCost', fn: filterCost },
		{ name: 'distinctCost', fn: distinctCost },
	];

	for (const { name, fn } of unaryCostFns) {
		describe(name, () => {
			it('zero rows: cost >= 0, finite', () => {
				expectValidCost(fn(0), `${name}(0)`);
			});

			it('one row: cost > 0', () => {
				expect(fn(1)).to.be.greaterThan(0);
			});

			it('monotonicity: cost(100) > cost(10)', () => {
				expect(fn(100)).to.be.greaterThan(fn(10));
			});

			it('large input (1M rows): finite, no overflow', () => {
				expectValidCost(fn(1_000_000), `${name}(1M)`);
			});

			it('very large input (1e9 rows): finite, no overflow', () => {
				expectValidCost(fn(1e9), `${name}(1e9)`);
			});

			it('fractional rows: valid cost', () => {
				expectValidCost(fn(0.5), `${name}(0.5)`);
			});
		});
	}

	describe('projectCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(projectCost(0), 'projectCost(0)');
		});

		it('one row: cost > 0', () => {
			expect(projectCost(1)).to.be.greaterThan(0);
		});

		it('monotonicity: cost(100) > cost(10)', () => {
			expect(projectCost(100)).to.be.greaterThan(projectCost(10));
		});

		it('more projections increase cost', () => {
			expect(projectCost(100, 5)).to.be.greaterThan(projectCost(100, 1));
		});

		it('large input: finite', () => {
			expectValidCost(projectCost(1_000_000, 10), 'projectCost(1M, 10)');
		});
	});

	describe('aggregateCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(aggregateCost(0, 0), 'aggregateCost(0,0)');
		});

		it('one row one group: cost > 0', () => {
			expect(aggregateCost(1, 1)).to.be.greaterThan(0);
		});

		it('monotonicity in input rows', () => {
			expect(aggregateCost(100, 10)).to.be.greaterThan(aggregateCost(10, 10));
		});

		it('monotonicity in output groups', () => {
			expect(aggregateCost(100, 50)).to.be.greaterThan(aggregateCost(100, 10));
		});

		it('large input: finite', () => {
			expectValidCost(aggregateCost(1_000_000, 1000), 'aggregateCost(1M, 1K)');
		});
	});

	describe('hashAggregateCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(hashAggregateCost(0, 0), 'hashAggregateCost(0,0)');
		});

		it('one row: cost > 0', () => {
			expect(hashAggregateCost(1, 1)).to.be.greaterThan(0);
		});

		it('monotonicity in input rows', () => {
			expect(hashAggregateCost(100, 10)).to.be.greaterThan(hashAggregateCost(10, 10));
		});

		it('large input: finite', () => {
			expectValidCost(hashAggregateCost(1_000_000, 1000), 'hashAggregateCost(1M, 1K)');
		});
	});

	describe('streamAggregateCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(streamAggregateCost(0, 0), 'streamAggregateCost(0,0)');
		});

		it('one row: cost > 0', () => {
			expect(streamAggregateCost(1, 1)).to.be.greaterThan(0);
		});

		it('monotonicity in input rows', () => {
			expect(streamAggregateCost(100, 10)).to.be.greaterThan(streamAggregateCost(10, 10));
		});

		it('large input: finite', () => {
			expectValidCost(streamAggregateCost(1_000_000, 1000), 'streamAggregateCost(1M, 1K)');
		});
	});

	describe('limitCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(limitCost(0, 10), 'limitCost(0, 10)');
		});

		it('one row: cost > 0', () => {
			expect(limitCost(1, 10)).to.be.greaterThan(0);
		});

		it('limit caps processed rows', () => {
			expect(limitCost(1000, 10)).to.equal(limitCost(100, 10));
		});

		it('large input: finite', () => {
			expectValidCost(limitCost(1_000_000, 100), 'limitCost(1M, 100)');
		});
	});

	describe('cacheCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(cacheCost(0), 'cacheCost(0)');
		});

		it('one row: cost > 0', () => {
			expect(cacheCost(1)).to.be.greaterThan(0);
		});

		it('monotonicity in rows', () => {
			expect(cacheCost(100)).to.be.greaterThan(cacheCost(10));
		});

		it('more accesses increase cost', () => {
			expect(cacheCost(100, 5)).to.be.greaterThan(cacheCost(100, 1));
		});

		it('large input: finite', () => {
			expectValidCost(cacheCost(1_000_000, 10), 'cacheCost(1M, 10)');
		});
	});

	// ─── Join cost functions: boundary and monotonicity ─────────────────

	describe('nestedLoopJoinCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(nestedLoopJoinCost(0, 0), 'nlj(0,0)');
		});

		it('one row each: cost > 0', () => {
			expect(nestedLoopJoinCost(1, 1)).to.be.greaterThan(0);
		});

		it('scales with outer × inner', () => {
			const small = nestedLoopJoinCost(10, 10);
			const largeInner = nestedLoopJoinCost(10, 100);
			const largeOuter = nestedLoopJoinCost(100, 10);
			expect(largeInner).to.be.greaterThan(small);
			expect(largeOuter).to.be.greaterThan(small);
		});

		it('cost roughly proportional to product for large inputs', () => {
			const c1 = nestedLoopJoinCost(100, 100);
			const c2 = nestedLoopJoinCost(200, 200);
			// 200×200 = 4× the product of 100×100, so cost should be roughly 4×
			expect(c2).to.be.greaterThan(c1 * 3);
		});

		it('large input: finite', () => {
			expectValidCost(nestedLoopJoinCost(10_000, 10_000), 'nlj(10K, 10K)');
		});

		it('very large input (1e9 × small): finite', () => {
			expectValidCost(nestedLoopJoinCost(1e9, 10), 'nlj(1e9, 10)');
		});
	});

	describe('mergeJoinCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(mergeJoinCost(0, 0, false, false), 'mj(0,0)');
		});

		it('one row each: cost > 0', () => {
			expect(mergeJoinCost(1, 1, false, false)).to.be.greaterThan(0);
		});

		it('cost proportional to sum (not product) of inputs', () => {
			const sum100 = mergeJoinCost(50, 50, false, false);
			const sum200 = mergeJoinCost(100, 100, false, false);
			// sum doubles → cost should roughly double
			expect(sum200).to.be.closeTo(sum100 * 2, sum100 * 0.5);
		});

		it('adding sorts increases cost', () => {
			const noSort = mergeJoinCost(100, 100, false, false);
			const leftSort = mergeJoinCost(100, 100, true, false);
			const bothSort = mergeJoinCost(100, 100, true, true);
			expect(leftSort).to.be.greaterThan(noSort);
			expect(bothSort).to.be.greaterThan(leftSort);
		});

		it('large input: finite', () => {
			expectValidCost(mergeJoinCost(1_000_000, 1_000_000, true, true), 'mj(1M,1M)');
		});
	});

	describe('hashJoinCost', () => {
		it('zero rows: cost >= 0, finite', () => {
			expectValidCost(hashJoinCost(0, 0), 'hj(0,0)');
		});

		it('one row each: cost > 0', () => {
			expect(hashJoinCost(1, 1)).to.be.greaterThan(0);
		});

		it('build cost proportional to build side', () => {
			const small = hashJoinCost(100, 1000);
			const largeBuild = hashJoinCost(200, 1000);
			// doubled build rows → notable increase but not doubled total
			expect(largeBuild).to.be.greaterThan(small);
		});

		it('large input: finite', () => {
			expectValidCost(hashJoinCost(1_000_000, 1_000_000), 'hj(1M,1M)');
		});
	});

	// ─── Relative cost ordering ────────────────────────────────────────

	describe('relative cost ordering', () => {
		it('indexSeekCost < indexScanCost < seqScanCost for same row count', () => {
			for (const n of [10, 100, 1000, 10_000]) {
				expect(indexSeekCost(n), `seek vs scan at ${n}`).to.be.lessThan(indexScanCost(n));
				expect(indexScanCost(n), `scan vs seq at ${n}`).to.be.lessThan(seqScanCost(n));
			}
		});

		it('mergeJoinCost < nestedLoopJoinCost for large inputs (pre-sorted)', () => {
			for (const n of [100, 1000, 10_000]) {
				expect(
					mergeJoinCost(n, n, false, false),
					`merge vs nlj at ${n}`
				).to.be.lessThan(nestedLoopJoinCost(n, n));
			}
		});

		it('hashJoinCost < nestedLoopJoinCost for large inputs', () => {
			for (const n of [100, 1000, 10_000]) {
				expect(
					hashJoinCost(n, n),
					`hash vs nlj at ${n}`
				).to.be.lessThan(nestedLoopJoinCost(n, n));
			}
		});

		it('streamAggregateCost < hashAggregateCost when pre-sorted (fewer groups)', () => {
			// Stream aggregate is cheaper when the input is already sorted
			for (const inputRows of [100, 1000, 10_000]) {
				const groups = Math.ceil(inputRows / 10);
				expect(
					streamAggregateCost(inputRows, groups),
					`stream vs hash agg at ${inputRows} rows, ${groups} groups`
				).to.be.lessThan(hashAggregateCost(inputRows, groups));
			}
		});

		it('limitCost with small limit < full scan cost', () => {
			const fullScan = seqScanCost(10_000);
			const limited = limitCost(10_000, 10);
			expect(limited).to.be.lessThan(fullScan);
		});
	});

	// ─── chooseCheapest() ──────────────────────────────────────────────

	describe('chooseCheapest', () => {
		it('returns the option with minimum cost', () => {
			const result = chooseCheapest([
				{ cost: 10, option: 'A' },
				{ cost: 5, option: 'B' },
				{ cost: 20, option: 'C' },
			]);
			expect(result).to.equal('B');
		});

		it('ties: returns first option', () => {
			const result = chooseCheapest([
				{ cost: 5, option: 'first' },
				{ cost: 5, option: 'second' },
			]);
			expect(result).to.equal('first');
		});

		it('single option: returns it', () => {
			const result = chooseCheapest([{ cost: 42, option: 'only' }]);
			expect(result).to.equal('only');
		});

		it('empty options: throws', () => {
			expect(() => chooseCheapest([])).to.throw();
		});
	});

	// ─── Edge cases ────────────────────────────────────────────────────

	describe('edge cases', () => {
		it('fractional row estimates produce valid costs', () => {
			expectValidCost(seqScanCost(0.5));
			expectValidCost(indexSeekCost(0.5));
			expectValidCost(filterCost(0.5));
			expectValidCost(sortCost(0.5));
			expectValidCost(nestedLoopJoinCost(0.5, 0.5));
			expectValidCost(hashJoinCost(0.5, 0.5));
			expectValidCost(mergeJoinCost(0.5, 0.5, false, false));
			expectValidCost(aggregateCost(0.5, 0.5));
		});

		it('very large row counts (1e9) produce valid costs', () => {
			expectValidCost(seqScanCost(1e9));
			expectValidCost(indexSeekCost(1e9));
			expectValidCost(indexScanCost(1e9));
			expectValidCost(sortCost(1e9));
			expectValidCost(filterCost(1e9));
			expectValidCost(distinctCost(1e9));
			expectValidCost(nestedLoopJoinCost(1e9, 10));
			expectValidCost(hashJoinCost(1e9, 1e9));
			expectValidCost(mergeJoinCost(1e9, 1e9, false, false));
			expectValidCost(aggregateCost(1e9, 1e6));
			expectValidCost(hashAggregateCost(1e9, 1e6));
			expectValidCost(streamAggregateCost(1e9, 1e6));
		});

		it('negative row counts: no NaN (defensive)', () => {
			// These shouldn't happen in practice, but verify no NaN
			const negCosts = [
				seqScanCost(-1),
				indexSeekCost(-1),
				filterCost(-1),
				distinctCost(-1),
			];
			for (const c of negCosts) {
				expect(Number.isNaN(c), `negative input produced NaN: ${c}`).to.be.false;
			}
		});
	});
});
