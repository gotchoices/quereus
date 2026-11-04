/**
 * Exact numeric comparison for `.sqllogic` JSON: expected results and bind parameters.
 *
 * Kept apart from `logic.spec.ts` because importing that file would register the whole suite.
 * The rules below are part of the corpus format; see `test/README.md` § Logic-test conventions.
 */

const INTEGER_LITERAL = /^-?\d+$/;

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** The third reviver argument from the JSON.parse source text access feature, absent from TypeScript's lib types. */
interface JsonReviverContext {
	source?: string;
}

function reviveExactNumber(_key: string, value: unknown, context?: JsonReviverContext): unknown {
	if (typeof value !== 'number') return value;
	if (context?.source === undefined) {
		throw new Error('Exact .sqllogic number comparison needs JSON.parse source text access (context.source); upgrade Node.');
	}
	return INTEGER_LITERAL.test(context.source) && !Number.isSafeInteger(value) ? BigInt(context.source) : value;
}

/**
 * JSON.parse that keeps integers exact. An integer-shaped literal states an exact integer, so one
 * outside the safe-integer range becomes a bigint. A literal with a fraction or an exponent states
 * a double: `1e308` and `9007199254740993.0` read as the double nearest that text.
 */
export function parseExactJson(text: string): unknown {
	return JSON.parse(text, reviveExactNumber);
}

/**
 * Gives each numeric value one representation, so deep equality compares exact mathematical values:
 * a bigint in the safe-integer range becomes a number, and an integer-valued number outside it
 * becomes the bigint with that double's exact value. Consequently a bigint and a double that hold
 * the same value compare equal, and a value no double can hold, like 2^53 + 1, matches no double.
 *
 * Arrays and objects recurse. A Uint8Array becomes a plain object keyed by index.
 */
export function canonicalNumbers(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value;
	}
	if (typeof value === 'number') {
		return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value) : value;
	}
	if (Array.isArray(value)) return value.map(canonicalNumbers);
	if (value !== null && typeof value === 'object') {
		// fromEntries defines own properties; assigning a `__proto__` key would drop it from both sides of the comparison.
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonicalNumbers(entry)]));
	}
	return value;
}
