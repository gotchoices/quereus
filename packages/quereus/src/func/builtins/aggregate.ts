import { createLogger } from '../../common/logger.js';
import type { SqlValue } from '../../common/types.js';
import { createAggregateFunction } from '../registration.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';

const log = createLogger('func:builtins:aggregate');
const warnLog = log.extend('warn');

// --- count(*) ---
export const countStarFunc = createAggregateFunction(
	{ name: 'count', numArgs: 0, initialValue: 0 },
	(acc: number): number => acc + 1,
	(acc: number): number => acc
);

// --- SUM(X) ---
export const sumFunc = createAggregateFunction(
	{ name: 'sum', numArgs: 1, initialValue: null },
	(acc: { sum: number | bigint } | null, value: SqlValue): { sum: number | bigint } | null => {
		if (value === null) return acc; // Ignore NULLs
		const currentSum = acc?.sum ?? 0; // Initialize sum to 0 if null
		let numValue: number | bigint;

		try {
			if (typeof value === 'bigint') {
				numValue = value;
			} else if (typeof value === 'number') {
				numValue = value;
			} else if (typeof value === 'string') {
				const parsed = Number(value);
				if (isNaN(parsed)) return acc;
				numValue = parsed;
			} else if (typeof value === 'boolean') {
				numValue = value ? 1 : 0;
			} else {
				return acc; // Ignore non-numeric types like Uint8Array
			}

			// Promote to BigInt if either is BigInt or if result might overflow Number
			if (typeof currentSum === 'bigint' || typeof numValue === 'bigint') {
				return { sum: BigInt(currentSum) + BigInt(numValue) };
			} else {
				// Check potential overflow before adding as numbers
				const potentialSum = (currentSum as number) + (numValue as number);
				if (potentialSum > Number.MAX_SAFE_INTEGER || potentialSum < Number.MIN_SAFE_INTEGER) {
					return { sum: BigInt(currentSum) + BigInt(numValue) };
				}
				return { sum: potentialSum };
			}
		} catch (e) {
			warnLog("Error during SUM step coercion: %O", e);
			return acc; // Ignore value if coercion fails
		}
	},
	(acc: { sum: number | bigint } | null): number | bigint | null => {
		// SQLite returns NULL for SUM of empty set, INTEGER or REAL result
		return acc?.sum ?? null;
	}
);

// --- AVG(X) ---
interface AvgAccumulator { sum: number; count: number }
export const avgFunc = createAggregateFunction(
	{ name: 'avg', numArgs: 1, initialValue: { sum: 0, count: 0 } },
	(acc: AvgAccumulator, value: SqlValue): AvgAccumulator => {
		if (value === null) return acc; // Ignore NULLs
		let numValue = value;
		try {
			if (typeof value !== 'bigint') {
				numValue = Number(value);
				if (isNaN(numValue as number)) return acc; // Ignore non-numeric
			}

			// Use floating point for sum in AVG to avoid potential BigInt division issues
			const newSum = acc.sum + Number(numValue);
			return { sum: newSum, count: acc.count + 1 };
		} catch (e) {
			warnLog("Error during AVG step coercion: %O", e);
			return acc;
		}
	},
	(acc: AvgAccumulator): number | null => {
		if (acc.count === 0) return null; // NULL for empty set
		return acc.sum / acc.count;
	}
);

// --- MIN(X) ---
export const minFunc = createAggregateFunction(
	{
		name: 'min',
		numArgs: 1,
		initialValue: null,
		// Type inference: return the same type as the input argument
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: true, // MIN can return NULL if all values are NULL or no rows
			isReadOnly: true
		})
	},
	(acc: { min: SqlValue } | null, value: SqlValue): { min: SqlValue } | null => {
		if (value === null) return acc; // Ignore NULLs
		if (acc === null) return { min: value }; // First non-null value
		return compareSqlValuesFast(value, acc.min, BINARY_COLLATION) < 0 ? { min: value } : acc;
	},
	(acc: { min: SqlValue } | null): SqlValue | null => {
		return acc?.min ?? null;
	}
);

// --- MAX(X) ---
export const maxFunc = createAggregateFunction(
	{
		name: 'max',
		numArgs: 1,
		initialValue: null,
		// Type inference: return the same type as the input argument
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: true, // MAX can return NULL if all values are NULL or no rows
			isReadOnly: true
		})
	},
	(acc: { max: SqlValue } | null, value: SqlValue): { max: SqlValue } | null => {
		if (value === null) return acc; // Ignore NULLs
		if (acc === null) return { max: value }; // First non-null value
		return compareSqlValuesFast(value, acc.max, BINARY_COLLATION) > 0 ? { max: value } : acc;
	},
	(acc: { max: SqlValue } | null): SqlValue | null => {
		return acc?.max ?? null;
	}
);

// --- COUNT(X) ---
// Counts non-NULL values of X
export const countXFunc = createAggregateFunction(
	{ name: 'count', numArgs: 1, initialValue: 0 },
	(acc: number, value: SqlValue): number => {
		if (value === null) return acc; // Do not count NULLs
		return acc + 1;
	},
	(acc: number): number => acc
);

// --- GROUP_CONCAT(X, Y?) ---
interface GroupConcatAccumulator {
	values: string[];
	separator: string;
}
export const groupConcatFuncRev = createAggregateFunction(
	{ name: 'group_concat', numArgs: -1, initialValue: () => ({ values: [], separator: ',' }) },
	(acc: GroupConcatAccumulator, value: SqlValue, separator: SqlValue = ','): GroupConcatAccumulator => {
		const currentSeparator = (separator === undefined || separator === null) ? acc.separator : String(separator);
		acc.separator = currentSeparator;

		if (value === null) {
			return acc;
		}

		acc.values.push(String(value));
		return acc;
	},
	(acc: GroupConcatAccumulator): string | null => {
		if (acc.values.length === 0) {
			return null;
		}
		return acc.values.join(acc.separator);
	}
);

// --- TOTAL(X) ---
export const totalFunc = createAggregateFunction(
	{ name: 'total', numArgs: 1, initialValue: 0.0 },
	(acc: number, value: SqlValue): number => {
		let numValue = 0.0;
		if (value !== null) {
			try {
				// Attempt numeric conversion, default to 0.0 if not possible
				numValue = Number(value);
				if (isNaN(numValue)) {
					numValue = 0.0;
				}
			} catch {
				numValue = 0.0;
			}
		}
		// Always use floating-point arithmetic
		return acc + numValue;
	},
	(acc: number): number => acc // Returns 0.0 for empty set or only NULL inputs
);

// --- Statistical Aggregates (Variance, Standard Deviation) ---
interface StatAccumulator {
	count: number;
	sum: number;
	sumSq: number;
}

const statReducer = (acc: StatAccumulator, value: SqlValue): StatAccumulator => {
	if (value === null) {
		return acc; // Ignore NULLs
	}
	try {
		const numValue = Number(value);
		if (isNaN(numValue)) {
			return acc; // Ignore non-numeric
		}
		// Use floating-point for calculations
		return {
			count: acc.count + 1,
			sum: acc.sum + numValue,
			sumSq: acc.sumSq + (numValue * numValue),
		};
	} catch (e) {
		warnLog("Error during statistical aggregate step coercion: %O", e);
		return acc;
	}
};

// Population Variance (VAR_POP)
export const varPopFunc = createAggregateFunction(
	{ name: 'var_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null; // NULL for empty set
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance;
	}
);

// Sample Variance (VAR_SAMP)
export const varSampFunc = createAggregateFunction(
	{ name: 'var_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null; // NULL if count is 0 or 1
		// Sample variance: (sumSq - n*avg^2) / (n-1) == (sumSq - sum*sum/n) / (n-1)
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance;
	}
);

// Population Standard Deviation (STDDEV_POP)
export const stdDevPopFunc = createAggregateFunction(
	{ name: 'stddev_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null;
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);

// Sample Standard Deviation (STDDEV_SAMP)
export const stdDevSampFunc = createAggregateFunction(
	{ name: 'stddev_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null;
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);
