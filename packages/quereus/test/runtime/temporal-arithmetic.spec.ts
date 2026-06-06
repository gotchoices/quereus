import { expect } from 'chai';
import { tryTemporalArithmetic, tryTemporalComparison } from '../../src/runtime/emit/temporal-arithmetic.js';

describe('tryTemporalArithmetic', () => {

	// ---------------------------------------------------------------
	// NULL propagation
	// ---------------------------------------------------------------
	describe('NULL propagation', () => {
		it('returns null when first operand is null', () => {
			expect(tryTemporalArithmetic('+', null, '2024-01-15')).to.equal(null);
		});
		it('returns null when second operand is null', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15', null)).to.equal(null);
		});
		it('returns null when both operands are null', () => {
			expect(tryTemporalArithmetic('+', null, null)).to.equal(null);
		});
	});

	// ---------------------------------------------------------------
	// Non-temporal → undefined
	// ---------------------------------------------------------------
	describe('non-temporal operands', () => {
		it('returns undefined for two numbers', () => {
			expect(tryTemporalArithmetic('+', 1, 2)).to.equal(undefined);
		});
		it('returns undefined for two plain strings', () => {
			expect(tryTemporalArithmetic('+', 'foo', 'bar')).to.equal(undefined);
		});
		it('returns undefined for boolean operands', () => {
			expect(tryTemporalArithmetic('+', true, false)).to.equal(undefined);
		});
	});

	// ---------------------------------------------------------------
	// DATE + TIMESPAN → DATE
	// ---------------------------------------------------------------
	describe('date + timespan', () => {
		it('adds days to a date', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15', 'P10D')).to.equal('2024-01-25');
		});
		it('adds months to a date', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15', 'P3M')).to.equal('2024-04-15');
		});
		it('adds years to a date', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15', 'P1Y')).to.equal('2025-01-15');
		});
		it('month rollover: Jan 31 + 1 month → Feb 29 (leap year)', () => {
			expect(tryTemporalArithmetic('+', '2024-01-31', 'P1M')).to.equal('2024-02-29');
		});
		it('month rollover: Jan 31 + 1 month → Feb 28 (non-leap year)', () => {
			expect(tryTemporalArithmetic('+', '2023-01-31', 'P1M')).to.equal('2023-02-28');
		});
		it('leap year: Feb 29 + 1 year → Feb 28', () => {
			expect(tryTemporalArithmetic('+', '2024-02-29', 'P1Y')).to.equal('2025-02-28');
		});
		it('negative timespan subtracts', () => {
			expect(tryTemporalArithmetic('+', '2024-03-15', '-P10D')).to.equal('2024-03-05');
		});
		it('zero timespan is identity', () => {
			expect(tryTemporalArithmetic('+', '2024-06-15', 'PT0S')).to.equal('2024-06-15');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN + DATE → DATE (commutative)
	// ---------------------------------------------------------------
	describe('timespan + date', () => {
		it('commutative: timespan + date adds to date', () => {
			expect(tryTemporalArithmetic('+', 'P10D', '2024-01-15')).to.equal('2024-01-25');
		});
		it('commutative: timespan with months + date', () => {
			expect(tryTemporalArithmetic('+', 'P2M', '2024-01-31')).to.equal('2024-03-31');
		});
	});

	// ---------------------------------------------------------------
	// DATE - TIMESPAN → DATE
	// ---------------------------------------------------------------
	describe('date - timespan', () => {
		it('subtracts days from date', () => {
			expect(tryTemporalArithmetic('-', '2024-01-25', 'P10D')).to.equal('2024-01-15');
		});
		it('subtracts months from date', () => {
			expect(tryTemporalArithmetic('-', '2024-03-31', 'P1M')).to.equal('2024-02-29');
		});
		it('subtracts with negative timespan (effectively adds)', () => {
			expect(tryTemporalArithmetic('-', '2024-01-15', '-P10D')).to.equal('2024-01-25');
		});
	});

	// ---------------------------------------------------------------
	// DATE - DATE → TIMESPAN
	// ---------------------------------------------------------------
	describe('date - date', () => {
		it('same date yields zero duration', () => {
			expect(tryTemporalArithmetic('-', '2024-01-15', '2024-01-15')).to.equal('PT0S');
		});
		it('later - earlier yields positive duration', () => {
			expect(tryTemporalArithmetic('-', '2024-01-25', '2024-01-15')).to.equal('P10D');
		});
		it('earlier - later yields negative duration', () => {
			expect(tryTemporalArithmetic('-', '2024-01-15', '2024-01-25')).to.equal('-P10D');
		});
	});

	// ---------------------------------------------------------------
	// DATETIME + TIMESPAN → DATETIME
	// ---------------------------------------------------------------
	describe('datetime + timespan', () => {
		it('adds hours to datetime', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15T10:00:00', 'PT2H')).to.equal('2024-01-15T12:00:00');
		});
		it('adds days crossing midnight', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15T23:00:00', 'PT2H')).to.equal('2024-01-16T01:00:00');
		});
		it('adds months with rollover', () => {
			expect(tryTemporalArithmetic('+', '2024-01-31T12:00:00', 'P1M')).to.equal('2024-02-29T12:00:00');
		});
		it('negative timespan subtracts', () => {
			expect(tryTemporalArithmetic('+', '2024-01-15T12:00:00', '-PT3H')).to.equal('2024-01-15T09:00:00');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN + DATETIME → DATETIME (commutative)
	// ---------------------------------------------------------------
	describe('timespan + datetime', () => {
		it('commutative: timespan + datetime', () => {
			expect(tryTemporalArithmetic('+', 'PT2H', '2024-01-15T10:00:00')).to.equal('2024-01-15T12:00:00');
		});
	});

	// ---------------------------------------------------------------
	// DATETIME - TIMESPAN → DATETIME
	// ---------------------------------------------------------------
	describe('datetime - timespan', () => {
		it('subtracts hours from datetime', () => {
			expect(tryTemporalArithmetic('-', '2024-01-15T12:00:00', 'PT2H')).to.equal('2024-01-15T10:00:00');
		});
		it('subtracts across day boundary', () => {
			expect(tryTemporalArithmetic('-', '2024-01-16T01:00:00', 'PT2H')).to.equal('2024-01-15T23:00:00');
		});
	});

	// ---------------------------------------------------------------
	// DATETIME - DATETIME → TIMESPAN (via date subtraction)
	// ---------------------------------------------------------------
	describe('datetime - datetime', () => {
		it('same datetime yields zero', () => {
			expect(tryTemporalArithmetic('-', '2024-01-15T12:00:00', '2024-01-15T12:00:00')).to.equal('PT0S');
		});
		it('later - earlier yields positive', () => {
			// Date-level subtraction (time component is stripped to date)
			expect(tryTemporalArithmetic('-', '2024-01-25T00:00:00', '2024-01-15T00:00:00')).to.equal('P10D');
		});
	});

	// ---------------------------------------------------------------
	// DATE - DATETIME and DATETIME - DATE (mixed)
	// ---------------------------------------------------------------
	describe('mixed date/datetime subtraction', () => {
		it('date - datetime', () => {
			expect(tryTemporalArithmetic('-', '2024-01-25', '2024-01-15T10:00:00')).to.equal('P10D');
		});
		it('datetime - date', () => {
			expect(tryTemporalArithmetic('-', '2024-01-25T10:00:00', '2024-01-15')).to.equal('P10D');
		});
	});

	// ---------------------------------------------------------------
	// TIME + TIMESPAN → TIME
	// ---------------------------------------------------------------
	describe('time + timespan', () => {
		it('adds hours to time', () => {
			expect(tryTemporalArithmetic('+', '10:00:00', 'PT2H')).to.equal('12:00:00');
		});
		it('adds minutes to time', () => {
			expect(tryTemporalArithmetic('+', '10:00:00', 'PT30M')).to.equal('10:30:00');
		});
		it('wraps around midnight', () => {
			expect(tryTemporalArithmetic('+', '23:00:00', 'PT2H')).to.equal('01:00:00');
		});
		it('zero timespan is identity', () => {
			expect(tryTemporalArithmetic('+', '14:30:00', 'PT0S')).to.equal('14:30:00');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN + TIME → TIME (commutative)
	// ---------------------------------------------------------------
	describe('timespan + time', () => {
		it('commutative: timespan + time', () => {
			expect(tryTemporalArithmetic('+', 'PT2H', '10:00:00')).to.equal('12:00:00');
		});
	});

	// ---------------------------------------------------------------
	// TIME - TIMESPAN → TIME
	// ---------------------------------------------------------------
	describe('time - timespan', () => {
		it('subtracts hours from time', () => {
			expect(tryTemporalArithmetic('-', '12:00:00', 'PT2H')).to.equal('10:00:00');
		});
		it('wraps before midnight', () => {
			expect(tryTemporalArithmetic('-', '01:00:00', 'PT2H')).to.equal('23:00:00');
		});
	});

	// ---------------------------------------------------------------
	// TIME - TIME → TIMESPAN
	// ---------------------------------------------------------------
	describe('time - time', () => {
		it('same time yields zero', () => {
			expect(tryTemporalArithmetic('-', '12:00:00', '12:00:00')).to.equal('PT0S');
		});
		it('later - earlier yields positive', () => {
			expect(tryTemporalArithmetic('-', '14:00:00', '12:00:00')).to.equal('PT2H');
		});
		it('earlier - later yields negative', () => {
			expect(tryTemporalArithmetic('-', '10:00:00', '12:00:00')).to.equal('-PT2H');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN + TIMESPAN → TIMESPAN
	// ---------------------------------------------------------------
	describe('timespan + timespan', () => {
		it('adds two durations', () => {
			expect(tryTemporalArithmetic('+', 'PT1H', 'PT30M')).to.equal('PT1H30M');
		});
		it('adds with day component', () => {
			expect(tryTemporalArithmetic('+', 'P1D', 'PT12H')).to.equal('P1DT12H');
		});
		it('adds zero duration', () => {
			expect(tryTemporalArithmetic('+', 'PT1H', 'PT0S')).to.equal('PT1H');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN - TIMESPAN → TIMESPAN
	// ---------------------------------------------------------------
	describe('timespan - timespan', () => {
		it('subtracts two durations', () => {
			expect(tryTemporalArithmetic('-', 'PT2H', 'PT30M')).to.equal('PT1H30M');
		});
		it('subtracting equal durations yields zero', () => {
			expect(tryTemporalArithmetic('-', 'PT1H', 'PT1H')).to.equal('PT0S');
		});
		it('subtracting larger yields negative', () => {
			expect(tryTemporalArithmetic('-', 'PT30M', 'PT1H')).to.equal('-PT30M');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN * NUMBER → TIMESPAN
	// ---------------------------------------------------------------
	describe('timespan * number', () => {
		it('scales duration by integer', () => {
			expect(tryTemporalArithmetic('*', 'PT1H', 2)).to.equal('PT7200S');
		});
		it('scales duration by fractional', () => {
			expect(tryTemporalArithmetic('*', 'PT1H', 0.5)).to.equal('PT1800S');
		});
		it('scales by zero yields zero', () => {
			expect(tryTemporalArithmetic('*', 'PT1H', 0)).to.equal('PT0S');
		});
		it('scales calendar-unit duration', () => {
			expect(tryTemporalArithmetic('*', 'P1Y', 2)).to.equal('P2Y');
		});
	});

	// ---------------------------------------------------------------
	// NUMBER * TIMESPAN → TIMESPAN (commutative)
	// ---------------------------------------------------------------
	describe('number * timespan', () => {
		it('commutative: number * timespan', () => {
			expect(tryTemporalArithmetic('*', 2, 'PT1H')).to.equal('PT7200S');
		});
		it('commutative: number * calendar-unit duration', () => {
			expect(tryTemporalArithmetic('*', 3, 'P1M')).to.equal('P3M');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN / NUMBER → TIMESPAN
	// ---------------------------------------------------------------
	describe('timespan / number', () => {
		it('divides duration by integer', () => {
			expect(tryTemporalArithmetic('/', 'PT2H', 2)).to.equal('PT3600S');
		});
		it('divides duration by fractional', () => {
			expect(tryTemporalArithmetic('/', 'PT1H', 0.5)).to.equal('PT7200S');
		});
		it('divide by zero returns null', () => {
			expect(tryTemporalArithmetic('/', 'PT1H', 0)).to.equal(null);
		});
		it('divides calendar-unit duration', () => {
			expect(tryTemporalArithmetic('/', 'P6M', 2)).to.equal('P3M');
		});
	});

	// ---------------------------------------------------------------
	// TIMESPAN / TIMESPAN → NUMBER (ratio)
	// ---------------------------------------------------------------
	describe('timespan / timespan', () => {
		it('ratio of equal durations is 1', () => {
			expect(tryTemporalArithmetic('/', 'PT1H', 'PT1H')).to.equal(1);
		});
		it('ratio of double duration is 2', () => {
			expect(tryTemporalArithmetic('/', 'PT2H', 'PT1H')).to.equal(2);
		});
		it('ratio of half is 0.5', () => {
			expect(tryTemporalArithmetic('/', 'PT30M', 'PT1H')).to.equal(0.5);
		});
		it('divide by zero timespan returns null', () => {
			expect(tryTemporalArithmetic('/', 'PT1H', 'PT0S')).to.equal(null);
		});
		it('calendar unit ratio returns null (no fixed conversion)', () => {
			expect(tryTemporalArithmetic('/', 'P1Y', 'P1M')).to.equal(null);
		});
	});

	// ---------------------------------------------------------------
	// Unsupported operations
	// ---------------------------------------------------------------
	describe('unsupported temporal operations', () => {
		it('throws on date + date', () => {
			expect(() => tryTemporalArithmetic('+', '2024-01-15', '2024-01-20')).to.throw();
		});
		it('throws on time + time', () => {
			expect(() => tryTemporalArithmetic('+', '10:00:00', '12:00:00')).to.throw();
		});
		it('throws on date * number', () => {
			expect(() => tryTemporalArithmetic('*', '2024-01-15', 2)).to.throw();
		});
		it('throws on date / number', () => {
			expect(() => tryTemporalArithmetic('/', '2024-01-15', 2)).to.throw();
		});
		it('throws on timespan - date', () => {
			expect(() => tryTemporalArithmetic('-', 'P10D', '2024-01-15')).to.throw();
		});
	});
});

describe('tryTemporalComparison', () => {

	// ---------------------------------------------------------------
	// Non-timespan → undefined
	// ---------------------------------------------------------------
	describe('non-timespan operands', () => {
		it('returns undefined when neither is timespan', () => {
			expect(tryTemporalComparison('=', '2024-01-15', '2024-01-15')).to.equal(undefined);
		});
		it('returns undefined when first is not timespan', () => {
			expect(tryTemporalComparison('=', '2024-01-15', 'PT1H')).to.equal(undefined);
		});
		it('returns undefined when second is not timespan', () => {
			expect(tryTemporalComparison('=', 'PT1H', '2024-01-15')).to.equal(undefined);
		});
		it('returns undefined for numbers', () => {
			expect(tryTemporalComparison('=', 42, 42)).to.equal(undefined);
		});
		it('returns undefined for null', () => {
			expect(tryTemporalComparison('=', null, 'PT1H')).to.equal(undefined);
		});
	});

	// ---------------------------------------------------------------
	// Equality
	// ---------------------------------------------------------------
	describe('equality (=)', () => {
		it('equal durations', () => {
			expect(tryTemporalComparison('=', 'PT1H', 'PT1H')).to.equal(true);
		});
		it('unequal durations', () => {
			expect(tryTemporalComparison('=', 'PT1H', 'PT2H')).to.equal(false);
		});
		it('equivalent representations: PT60M = PT1H', () => {
			expect(tryTemporalComparison('=', 'PT60M', 'PT1H')).to.equal(true);
		});
		it('equivalent representations: PT3600S = PT1H', () => {
			expect(tryTemporalComparison('=', 'PT3600S', 'PT1H')).to.equal(true);
		});
		it('== alias works', () => {
			expect(tryTemporalComparison('==', 'PT1H', 'PT60M')).to.equal(true);
		});
	});

	// ---------------------------------------------------------------
	// Inequality
	// ---------------------------------------------------------------
	describe('inequality (!=, <>)', () => {
		it('!= on equal durations', () => {
			expect(tryTemporalComparison('!=', 'PT1H', 'PT1H')).to.equal(false);
		});
		it('!= on different durations', () => {
			expect(tryTemporalComparison('!=', 'PT1H', 'PT2H')).to.equal(true);
		});
		it('<> alias works', () => {
			expect(tryTemporalComparison('<>', 'PT1H', 'PT2H')).to.equal(true);
		});
	});

	// ---------------------------------------------------------------
	// Less than / greater than
	// ---------------------------------------------------------------
	describe('ordering (<, <=, >, >=)', () => {
		it('PT30M < PT1H', () => {
			expect(tryTemporalComparison('<', 'PT30M', 'PT1H')).to.equal(true);
		});
		it('PT1H < PT30M is false', () => {
			expect(tryTemporalComparison('<', 'PT1H', 'PT30M')).to.equal(false);
		});
		it('PT1H <= PT1H', () => {
			expect(tryTemporalComparison('<=', 'PT1H', 'PT1H')).to.equal(true);
		});
		it('PT30M <= PT1H', () => {
			expect(tryTemporalComparison('<=', 'PT30M', 'PT1H')).to.equal(true);
		});
		it('PT2H > PT1H', () => {
			expect(tryTemporalComparison('>', 'PT2H', 'PT1H')).to.equal(true);
		});
		it('PT1H > PT2H is false', () => {
			expect(tryTemporalComparison('>', 'PT1H', 'PT2H')).to.equal(false);
		});
		it('PT1H >= PT1H', () => {
			expect(tryTemporalComparison('>=', 'PT1H', 'PT1H')).to.equal(true);
		});
		it('PT30M >= PT1H is false', () => {
			expect(tryTemporalComparison('>=', 'PT30M', 'PT1H')).to.equal(false);
		});
	});

	// ---------------------------------------------------------------
	// Zero-length durations
	// ---------------------------------------------------------------
	describe('zero-length timespans', () => {
		it('PT0S = PT0S', () => {
			expect(tryTemporalComparison('=', 'PT0S', 'PT0S')).to.equal(true);
		});
		it('PT0S < PT1H', () => {
			expect(tryTemporalComparison('<', 'PT0S', 'PT1H')).to.equal(true);
		});
		it('PT0S is not greater than PT1S', () => {
			expect(tryTemporalComparison('>', 'PT0S', 'PT1S')).to.equal(false);
		});
	});

	// ---------------------------------------------------------------
	// Negative timespans
	// ---------------------------------------------------------------
	describe('negative timespans', () => {
		it('-PT1H < PT1H', () => {
			expect(tryTemporalComparison('<', '-PT1H', 'PT1H')).to.equal(true);
		});
		it('-PT1H < PT0S', () => {
			expect(tryTemporalComparison('<', '-PT1H', 'PT0S')).to.equal(true);
		});
		it('-PT30M > -PT1H', () => {
			expect(tryTemporalComparison('>', '-PT30M', '-PT1H')).to.equal(true);
		});
	});

	// ---------------------------------------------------------------
	// Unsupported operator
	// ---------------------------------------------------------------
	describe('unsupported operator', () => {
		it('returns undefined for LIKE', () => {
			expect(tryTemporalComparison('LIKE', 'PT1H', 'PT1H')).to.equal(undefined);
		});
	});
});
