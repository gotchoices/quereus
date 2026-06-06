import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { inferType } from '../../types/registry.js';

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	const logicalType = inferType(plan.expression.targetType);

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		if (operandValue === null) return null;

		if (logicalType.parse) {
			try {
				return logicalType.parse(operandValue);
			} catch {
				// CAST failures in SQL return 0 for numeric targets, '' for text, etc.
				// This matches SQLite's lenient CAST behavior.
				return castFallback(operandValue, logicalType.name);
			}
		}

		return operandValue;
	}

	return {
		params: [emitPlanNode(plan.operand, ctx)],
		run: run as InstructionRun,
		note: `cast(${plan.expression.targetType})`
	};
}

/**
 * Fallback for when LogicalType.parse throws on invalid input.
 * CAST in SQL is lenient: non-numeric strings cast to integer yield 0, etc.
 */
function castFallback(value: SqlValue, typeName: string): SqlValue {
	switch (typeName) {
		case 'INTEGER':
			return 0;
		case 'REAL':
			return 0.0;
		case 'NUMERIC':
			return 0;
		case 'TEXT':
			return String(value);
		case 'BLOB':
			return new TextEncoder().encode(String(value));
		default:
			return value;
	}
}
