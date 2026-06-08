import type { SqlValue } from "../../common/types.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast } from "../../util/comparison.js";
import type { EmissionContext } from "../emission-context.js";

export function emitBetween(plan: BetweenNode, ctx: EmissionContext): Instruction {
	// BETWEEN desugars to `expr >= lower AND expr <= upper`, where each comparison
	// resolves its collation independently with right(bound)-operand precedence,
	// mirroring emitComparisonOp. A plain column's collationName is the implicit
	// default 'BINARY' — always present and truthy — so an explicit COLLATE on a
	// bound must win over it: bound.collationName ?? expr.collationName ?? 'BINARY'.
	const exprColl = plan.expr.getType().collationName;
	const lowerCollationName = plan.lower.getType().collationName ?? exprColl ?? 'BINARY';
	const upperCollationName = plan.upper.getType().collationName ?? exprColl ?? 'BINARY';

	// Pre-resolve a collation function per comparison for optimal performance
	const lowerCollationFunc = ctx.resolveCollation(lowerCollationName);
	const upperCollationFunc = ctx.resolveCollation(upperCollationName);

	// Cross-category coercion is handled at plan time via explicit CastNodes,
	// so no runtime coercion is needed here.
	function run(ctx: RuntimeContext, value: SqlValue, lowerBound: SqlValue, upperBound: SqlValue): SqlValue {
		if (value === null || lowerBound === null || upperBound === null) return null;

		// NOT BETWEEN is `!(lower <= v <= upper)` = `v < lo (lowerColl) OR v > hi (upperColl)`,
		// which the per-bound negation below preserves.
		const lowerResult = compareSqlValuesFast(value, lowerBound, lowerCollationFunc);
		const upperResult = compareSqlValuesFast(value, upperBound, upperCollationFunc);
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
		note: `${notPrefix}BETWEEN${formatBetweenCollationNote(lowerCollationName, upperCollationName)}`
	};
}

/** Build the collation suffix for a BETWEEN note: nothing when both bounds are
 *  BINARY, a single name when they agree, or `lower/upper` when they differ. */
function formatBetweenCollationNote(lowerColl: string, upperColl: string): string {
	if (lowerColl === upperColl) {
		return lowerColl !== 'BINARY' ? ` ${lowerColl}` : '';
	}
	return ` ${lowerColl}/${upperColl}`;
}
