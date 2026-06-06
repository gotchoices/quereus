import { expect } from 'chai';
import { buildHistogram, selectivityFromHistogram } from '../../../src/planner/stats/histogram.js';
import type { EquiHeightHistogram } from '../../../src/planner/stats/catalog-stats.js';

// ── buildHistogram ──────────────────────────────────────────────────────

describe('buildHistogram', () => {
	it('returns undefined for empty input', () => {
		expect(buildHistogram([], 10)).to.be.undefined;
	});

	it('single value produces a single bucket', () => {
		const hist = buildHistogram([42], 10)!;
		expect(hist.buckets).to.have.lengthOf(1);
		expect(hist.buckets[0].upperBound).to.equal(42);
		expect(hist.buckets[0].cumulativeCount).to.equal(1);
		expect(hist.buckets[0].distinctCount).to.equal(1);
		expect(hist.sampleSize).to.equal(1);
	});

	it('all-same-value input has distinctCount=1 per bucket', () => {
		const hist = buildHistogram([7, 7, 7, 7, 7, 7], 3)!;
		for (const b of hist.buckets) {
			expect(b.distinctCount).to.equal(1);
			expect(b.upperBound).to.equal(7);
		}
	});

	it('caps bucket count to number of values', () => {
		const hist = buildHistogram([1, 2], 100)!;
		expect(hist.buckets).to.have.lengthOf(2);
	});

	it('last bucket cumulative count equals sample size', () => {
		const values = Array.from({ length: 50 }, (_, i) => i);
		const hist = buildHistogram(values, 5)!;
		expect(hist.buckets[hist.buckets.length - 1].cumulativeCount).to.equal(50);
		expect(hist.sampleSize).to.equal(50);
	});

	it('cumulative counts are non-decreasing', () => {
		const values = Array.from({ length: 200 }, (_, i) => i % 50);
		values.sort((a, b) => a - b);
		const hist = buildHistogram(values, 10)!;
		for (let i = 1; i < hist.buckets.length; i++) {
			expect(hist.buckets[i].cumulativeCount).to.be.at.least(hist.buckets[i - 1].cumulativeCount);
		}
	});

	it('upper bounds are non-decreasing for sorted input', () => {
		const values = Array.from({ length: 100 }, (_, i) => i * 2);
		const hist = buildHistogram(values, 10)!;
		for (let i = 1; i < hist.buckets.length; i++) {
			expect(hist.buckets[i].upperBound as number).to.be.at.least(hist.buckets[i - 1].upperBound as number);
		}
	});

	it('handles string values', () => {
		const hist = buildHistogram(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'], 3)!;
		expect(hist.buckets).to.have.lengthOf(3);
		expect(hist.buckets[hist.buckets.length - 1].upperBound).to.equal('foxtrot');
		expect(hist.sampleSize).to.equal(6);
	});

	it('numBuckets=1 produces a single bucket covering all values', () => {
		const values = Array.from({ length: 20 }, (_, i) => i);
		const hist = buildHistogram(values, 1)!;
		expect(hist.buckets).to.have.lengthOf(1);
		expect(hist.buckets[0].cumulativeCount).to.equal(20);
		expect(hist.buckets[0].distinctCount).to.equal(20);
	});

	it('tracks distinct values correctly within buckets', () => {
		// 10 values: [0,0,1,1,2,2,3,3,4,4] — 5 distinct
		const values = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
		const hist = buildHistogram(values, 2)!;
		// Total distinct across all buckets >= 5 (each bucket counts independently)
		const totalDistinct = hist.buckets.reduce((sum, b) => sum + b.distinctCount, 0);
		expect(totalDistinct).to.be.at.least(5);
	});
});

// ── selectivityFromHistogram ────────────────────────────────────────────

describe('selectivityFromHistogram', () => {
	function makeHist(n: number): EquiHeightHistogram {
		const values = Array.from({ length: n }, (_, i) => i);
		return buildHistogram(values, 10)!;
	}

	it('returns undefined for empty buckets', () => {
		const hist: EquiHeightHistogram = { buckets: [], sampleSize: 0 };
		expect(selectivityFromHistogram(hist, '=', 5, 100)).to.be.undefined;
	});

	it('returns undefined for totalRows=0', () => {
		const hist = makeHist(20);
		expect(selectivityFromHistogram(hist, '=', 5, 0)).to.be.undefined;
	});

	it('returns 0 when total cumulative count is 0', () => {
		const hist: EquiHeightHistogram = {
			buckets: [{ upperBound: 10, cumulativeCount: 0, distinctCount: 1 }],
			sampleSize: 0,
		};
		expect(selectivityFromHistogram(hist, '<', 5, 100)).to.equal(0);
	});

	// ── equality ────────────────────────────────────────────────────────

	describe('equality (=, ==)', () => {
		it('returns 1/distinctCount within containing bucket', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '=', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel!).to.be.greaterThan(0);
			expect(sel!).to.be.at.most(1);
		});

		it('== alias matches = behavior', () => {
			const hist = makeHist(100);
			const sel1 = selectivityFromHistogram(hist, '=', 50, 100);
			const sel2 = selectivityFromHistogram(hist, '==', 50, 100);
			expect(sel1).to.equal(sel2);
		});

		it('value above all buckets returns 0', () => {
			const hist = makeHist(50);
			expect(selectivityFromHistogram(hist, '=', 99999, 50)).to.equal(0);
		});
	});

	// ── less-than ───────────────────────────────────────────────────────

	describe('less-than (<)', () => {
		it('returns selectivity in [0,1] for midpoint', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '<', 50, 100)!;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('value above all buckets returns 1', () => {
			const hist = makeHist(100);
			expect(selectivityFromHistogram(hist, '<', 99999, 100)).to.equal(1);
		});

		it('value in first bucket returns small selectivity', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '<', 2, 100)!;
			expect(sel).to.be.lessThan(0.3);
		});
	});

	// ── less-than-or-equal ──────────────────────────────────────────────

	describe('less-than-or-equal (<=)', () => {
		it('returns selectivity in [0,1]', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '<=', 50, 100)!;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('value above all buckets returns 1', () => {
			const hist = makeHist(100);
			expect(selectivityFromHistogram(hist, '<=', 99999, 100)).to.equal(1);
		});
	});

	// ── greater-than ────────────────────────────────────────────────────

	describe('greater-than (>)', () => {
		it('returns selectivity in [0,1] for midpoint', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '>', 50, 100)!;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('value above all buckets returns 0', () => {
			const hist = makeHist(100);
			expect(selectivityFromHistogram(hist, '>', 99999, 100)).to.equal(0);
		});

		it('< and > selectivities are roughly complementary', () => {
			const hist = makeHist(100);
			const lt = selectivityFromHistogram(hist, '<', 50, 100)!;
			const gt = selectivityFromHistogram(hist, '>', 50, 100)!;
			expect(lt + gt).to.be.closeTo(1, 0.15);
		});
	});

	// ── greater-than-or-equal ───────────────────────────────────────────

	describe('greater-than-or-equal (>=)', () => {
		it('returns selectivity in [0,1]', () => {
			const hist = makeHist(100);
			const sel = selectivityFromHistogram(hist, '>=', 50, 100)!;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('value above all buckets returns 0', () => {
			const hist = makeHist(100);
			expect(selectivityFromHistogram(hist, '>=', 99999, 100)).to.equal(0);
		});

		it('<= and >= are roughly complementary', () => {
			const hist = makeHist(100);
			const le = selectivityFromHistogram(hist, '<=', 50, 100)!;
			const ge = selectivityFromHistogram(hist, '>=', 50, 100)!;
			// le + ge - pointEst ≈ 1
			expect(le + ge).to.be.at.least(0.85);
			expect(le + ge).to.be.at.most(1.25);
		});
	});

	// ── unsupported operators ───────────────────────────────────────────

	it('returns undefined for unsupported operators', () => {
		const hist = makeHist(100);
		expect(selectivityFromHistogram(hist, 'LIKE', 50, 100)).to.be.undefined;
		expect(selectivityFromHistogram(hist, 'IN', 50, 100)).to.be.undefined;
		expect(selectivityFromHistogram(hist, '!=', 50, 100)).to.be.undefined;
	});

	// ── boundary value tests ────────────────────────────────────────────

	describe('boundary values', () => {
		it('value at exact bucket boundary', () => {
			const hist = makeHist(100);
			const bound = hist.buckets[0].upperBound as number;
			const sel = selectivityFromHistogram(hist, '=', bound, 100);
			expect(sel).to.not.be.undefined;
			expect(sel!).to.be.greaterThan(0);
		});

		it('value at last bucket boundary', () => {
			const hist = makeHist(100);
			const last = hist.buckets[hist.buckets.length - 1].upperBound as number;
			const sel = selectivityFromHistogram(hist, '=', last, 100);
			expect(sel).to.not.be.undefined;
			expect(sel!).to.be.greaterThan(0);
		});

		it('single-bucket histogram equality', () => {
			const hist = buildHistogram([5, 5, 5], 1)!;
			const sel = selectivityFromHistogram(hist, '=', 5, 3);
			expect(sel).to.not.be.undefined;
			expect(sel).to.equal(1); // 1/distinctCount = 1/1 = 1
		});

		it('single-bucket histogram range', () => {
			const hist = buildHistogram([1, 2, 3, 4, 5], 1)!;
			const sel = selectivityFromHistogram(hist, '<', 3, 5);
			expect(sel).to.not.be.undefined;
			expect(sel!).to.be.at.least(0);
			expect(sel!).to.be.at.most(1);
		});
	});
});
