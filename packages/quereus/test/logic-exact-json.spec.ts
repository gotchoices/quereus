import { expect } from 'chai';
import { canonicalNumbers, parseExactJson } from './logic-exact-json.js';

function compared(expectedText: string, actual: unknown): { expected: unknown; actual: unknown } {
	return { expected: canonicalNumbers(parseExactJson(expectedText)), actual: canonicalNumbers([actual]) };
}

describe('sqllogic exact number comparison', () => {
	const matching: [string, string, unknown][] = [
		['an exact bigint past 2^53', '[9007199254740993]', 9007199254740993n],
		['a double whose exact value is the literal', '[9007199254740992]', 2 ** 53],
		['an exponent literal against the same double', '[1e308]', 1e308],
		['a safe-range bigint against a small literal', '[5]', 5n],
	];

	for (const [name, expectedText, actualValue] of matching) {
		it(`matches ${name}`, () => {
			const { expected, actual } = compared(expectedText, actualValue);
			expect(actual).to.deep.equal(expected);
		});
	}

	const differing: [string, string, unknown][] = [
		['an off-by-one bigint that rounds to the same double', '[9007199254740993]', 9007199254740992n],
		['a double, since no double holds 2^53 + 1', '[9007199254740993]', 2 ** 53],
	];

	for (const [name, expectedText, actualValue] of differing) {
		it(`rejects ${name}`, () => {
			const { expected, actual } = compared(expectedText, actualValue);
			expect(actual).to.not.deep.equal(expected);
		});
	}
});
