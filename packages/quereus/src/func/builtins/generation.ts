import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createTableValuedFunction } from "../registration.js";
import { evaluateLiteralOperand } from "../../schema/function.js";
import { INTEGER_TYPE } from "../../types/builtin-types.js";

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
				const end = evaluateLiteralOperand(operands[1]);
				if (typeof start === 'number' && typeof end === 'number' && end >= start) {
					return end - start + 1;
				}
				if (typeof start === 'bigint' && typeof end === 'bigint' && end >= start) {
					return Number(end - start) + 1;
				}
				if (typeof start === 'number' && typeof end === 'bigint' && end >= BigInt(start)) {
					return Number(end - BigInt(start)) + 1;
				}
				if (typeof start === 'bigint' && typeof end === 'number' && BigInt(end) >= start) {
					return Number(BigInt(end) - start) + 1;
				}
				return undefined;
			},
		},
	},
	async function* (start: SqlValue, end: SqlValue): AsyncIterable<Row> {
		const startNum = Number(start);
		const endNum = Number(end);

		if (isNaN(startNum) || isNaN(endNum)) return;

		for (let i = startNum; i <= endNum; ++i) {
			yield [i];
		}
	}
);
