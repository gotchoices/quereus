import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
	// INSERT node now only handles data transformations and passes flat rows through.
	// The actual database insert operations are handled by DmlExecutorNode.
	// Type conversion is handled by the table manager's validateAndParse in performInsert.
	async function* run(_ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
		const tableSchema = plan.table.tableSchema;
		const colCount = tableSchema.columns.length;

		for await (const sourceRow of sourceValue) {
			// Convert source row to flat OLD/NEW format
			// For INSERT: OLD values are all NULL, NEW values are from source
			const flatRow: Row = new Array(colCount * 2);

			// Fill OLD section with NULLs (indices 0..n-1)
			for (let i = 0; i < colCount; i++) {
				flatRow[i] = null;
			}

			// Fill NEW section with source values (indices n..2n-1)
			// No affinity conversion here - let the type system handle it
			for (let colIdx = 0; colIdx < colCount; colIdx++) {
				flatRow[colCount + colIdx] = sourceRow[colIdx];
			}

			yield flatRow;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: run as InstructionRun,
		note: `insertPrep(${plan.table.tableSchema.name})`
	};
}
