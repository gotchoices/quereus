import { expect } from 'chai';
import * as fc from 'fast-check';
import type { SqlValue } from '../../src/common/types.js';
import type { AggregateFunctionSchema } from '../../src/schema/function.js';
import type { AggValue } from '../../src/func/registration.js';
import { assertAggregateAlgebraLaws } from '../util/aggregate-algebra-laws.js';
import {
	countStarFunc, countXFunc, sumFunc, minFunc, maxFunc, avgFunc,
	totalFunc, groupConcatFuncRev, varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc,
} from '../../src/func/builtins/aggregate.js';

/** Integers + NULL — the exact domain for count/avg (avg sums as floats, so
 *  small integers keep every intermediate sum exact). */
const intOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000, max: 1_000 }).map((v): SqlValue => v),
);

/** Integers, overflow-scale bigints, and NULL — exercises sum's
 *  number→bigint promotion in merge/negate/decode (5n ≡ 5 under the
 *  storage-class-tolerant comparison). */
const sumDomain: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000_000, max: 1_000_000 }).map((v): SqlValue => v),
	fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map((v): SqlValue => v),
);

/** Mixed comparable values + NULL for min/max (cross-type BINARY ordering:
 *  numeric < text). NaN excluded — it is not a legal comparison-domain value. */
const comparableOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000, max: 1_000 }).map((v): SqlValue => v),
	fc.bigInt({ min: -1_000n, max: 1_000n }).map((v): SqlValue => v),
	fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map((v): SqlValue => v),
	fc.string().map((v): SqlValue => v),
);

describe('Aggregate algebra declarations', () => {
	describe('law harness over declared builtins', () => {
		it('count(*) satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(countStarFunc, intOrNull);
		});

		it('count(x) satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(countXFunc, intOrNull);
		});

		it('sum(x) satisfies the algebra laws over the integer domain', () => {
			assertAggregateAlgebraLaws(sumFunc, sumDomain);
		});

		it('min(x) satisfies the algebra laws over mixed comparable values', () => {
			assertAggregateAlgebraLaws(minFunc, comparableOrNull);
		});

		it('max(x) satisfies the algebra laws over mixed comparable values', () => {
			assertAggregateAlgebraLaws(maxFunc, comparableOrNull);
		});

		it('avg(x) satisfies the algebra laws, including its sum/count decomposition', () => {
			assertAggregateAlgebraLaws(avgFunc, intOrNull);
		});
	});

	describe('declaration shape pins', () => {
		it('avg declares decompose and NOT decode — the stored quotient forgets the count', () => {
			expect(avgFunc.algebra?.decompose, 'avg.decompose').to.exist;
			expect(avgFunc.algebra?.decode, 'avg.decode').to.equal(undefined);
			expect(avgFunc.algebra?.decompose?.partials.map((p) => `${p.func}/${p.arg}`))
				.to.deep.equal(['sum/same-arg', 'count/same-arg']);
		});

		it('min/max are tighten-only: merge without negate', () => {
			expect(minFunc.algebra?.merge, 'min.merge').to.be.a('function');
			expect(maxFunc.algebra?.merge, 'max.merge').to.be.a('function');
			expect(minFunc.algebra?.negate, 'min.negate').to.equal(undefined);
			expect(maxFunc.algebra?.negate, 'max.negate').to.equal(undefined);
		});

		it('decode of a stored NULL yields the empty accumulator, never a wrapped NULL', () => {
			expect(sumFunc.algebra?.decode?.(null), 'sum.decode(NULL)').to.equal(null);
			expect(minFunc.algebra?.decode?.(null), 'min.decode(NULL)').to.equal(null);
			expect(maxFunc.algebra?.decode?.(null), 'max.decode(NULL)').to.equal(null);
		});

		it('non-incremental builtins declare no algebra', () => {
			for (const f of [totalFunc, groupConcatFuncRev, varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc]) {
				expect(f.algebra, `${f.name}.algebra`).to.equal(undefined);
			}
		});
	});

	describe('negative twin — the harness catches a broken declaration', () => {
		it('a negate that returns its input fails the negate-inverse law', () => {
			const sumAlgebra = sumFunc.algebra;
			if (!sumAlgebra) throw new Error('sum must declare algebra');
			const broken: AggregateFunctionSchema = {
				...sumFunc,
				algebra: { ...sumAlgebra, negate: (a: AggValue): AggValue => a },
			};
			expect(() => assertAggregateAlgebraLaws(broken, sumDomain)).to.throw(/negate-inverse/);
		});

		it('a decode that fabricates a value fails the decode-observational law', () => {
			const sumAlgebra = sumFunc.algebra;
			if (!sumAlgebra) throw new Error('sum must declare algebra');
			const broken: AggregateFunctionSchema = {
				...sumFunc,
				algebra: { ...sumAlgebra, decode: (_stored: SqlValue): AggValue => ({ sum: 1, count: 1 }) },
			};
			expect(() => assertAggregateAlgebraLaws(broken, sumDomain)).to.throw(/decode-observational/);
		});
	});
});
