import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createTableValuedFunction } from "../registration.js";
import { evaluateLiteralOperand } from "../../schema/function.js";
import { INTEGER_TYPE, NUMERIC_TYPE } from "../../types/builtin-types.js";
import { canonicalizeInteger } from "../../util/numeric-canonical.js";

type SeriesInteger = number | bigint;

/** Reads a bound as a whole number. `null` means it has no integer reading, which empties the series. */
function seriesBound(value: SqlValue, round: (n: number) => number): SeriesInteger | null {
	const parsed = NUMERIC_TYPE.parse!(value) as SeriesInteger | null;
	if (parsed === null || typeof parsed === 'bigint') return parsed;
	if (!Number.isFinite(parsed)) return null;
	// `+ 0` turns the -0 from Math.ceil(-0.5) into 0.
	return canonicalizeInteger(round(parsed) + 0);
}

/** The first and last integer of the series. Fractional bounds round inward, so no value falls outside the requested range. */
function seriesRange(start: SqlValue, stop: SqlValue): { first: SeriesInteger; last: SeriesInteger } | null {
	const first = seriesBound(start, Math.ceil);
	const last = seriesBound(stop, Math.floor);
	return first === null || last === null ? null : { first, last };
}

/** Counts in `number` inside the safe range and `bigint` past it, where `i + 1` would stop changing `i`. */
function nextSeriesInteger(i: SeriesInteger): SeriesInteger {
	return typeof i === 'number' && i < Number.MAX_SAFE_INTEGER ? i + 1 : canonicalizeInteger(BigInt(i) + 1n);
}

// Generate a sequence of numbers (table-valued function)
export const generateSeriesFunc = createTableValuedFunction(
	{
		name: 'generate_series',
		numArgs: 2,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: 'value',
					type: {
						typeClass: 'scalar',
						logicalType: INTEGER_TYPE,
						nullable: false,
						isReadOnly: true
					},
					generated: true
				}
			],
			keys: [[{ index: 0 }]],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			keys: [[{ index: 0 }]],
			ordering: [{ column: 0, desc: false }],
			monotonicOnColumns: [{ column: 0, direction: 'asc', strict: true }],
			deterministic: true,
			estimatedRows: (operands) => {
				const start = evaluateLiteralOperand(operands[0]);
				const stop = evaluateLiteralOperand(operands[1]);
				if (start === undefined || stop === undefined) return undefined;
				const range = seriesRange(start, stop);
				if (range === null || range.last < range.first) return undefined;
				return Number(BigInt(range.last) - BigInt(range.first)) + 1;
			},
		},
	},
	async function* (start: SqlValue, stop: SqlValue): AsyncIterable<Row> {
		const range = seriesRange(start, stop);
		if (range === null) return;

		for (let i = range.first; i <= range.last; i = nextSeriesInteger(i)) {
			yield [i];
		}
	}
);
