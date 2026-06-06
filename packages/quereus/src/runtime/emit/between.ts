import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast } from "../../util/comparison.js";
import type { EmissionContext } from "../emission-context.js";

export function emitBetween(plan: BetweenNode, ctx: EmissionContext): Instruction {
	// Determine collation from operand types, matching emitComparisonOp behaviour
	const exprType = plan.expr.getType();
	const lowerType = plan.lower.getType();
	const upperType = plan.upper.getType();
	let collationName = 'BINARY';
	if (exprType.collationName) {
		collationName = exprType.collationName;
	} else if (lowerType.collationName) {
		collationName = lowerType.collationName;
	} else if (upperType.collationName) {
		collationName = upperType.collationName;
	}

	// Pre-resolve collation function for optimal performance
	const collationFunc = ctx.resolveCollation(collationName);

	// Cross-category coercion is handled at plan time via explicit CastNodes,
	// so no runtime coercion is needed here.
	function run(ctx: RuntimeContext, value: SqlValue, lowerBound: SqlValue, upperBound: SqlValue): SqlValue {
		if (value === null || lowerBound === null || upperBound === null) return null;

		const lowerResult = compareSqlValuesFast(value, lowerBound, collationFunc);
		const upperResult = compareSqlValuesFast(value, upperBound, collationFunc);
		const betweenResult = (lowerResult >= 0 && upperResult <= 0);

		return plan.expression.not ? !betweenResult : betweenResult;
	}

	const valueExpr = emitPlanNode(plan.expr, ctx);
	const lowerExpr = emitPlanNode(plan.lower, ctx);
	const upperExpr = emitPlanNode(plan.upper, ctx);

	const notPrefix = plan.expression.not ? 'NOT ' : '';

	return {
		params: [valueExpr, lowerExpr, upperExpr],
		run: run as InstructionRun,
		note: `${notPrefix}BETWEEN${collationName !== 'BINARY' ? ` ${collationName}` : ''}`
	};
}
