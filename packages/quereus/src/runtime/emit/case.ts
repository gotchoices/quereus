import type { CaseExprNode } from '../../planner/nodes/scalar.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { compareSqlValues } from '../../util/comparison.js';
import { isTruthy } from '../../util/comparison.js';

export function emitCaseExpr(plan: CaseExprNode, ctx: EmissionContext): Instruction {
	// Simple CASE: CASE base_expr WHEN value1 THEN result1 WHEN value2 THEN result2 ... END
	function runSimpleCase(
		runtimeCtx: RuntimeContext,
		...args: SqlValue[]
	): SqlValue {
		let argIndex = 0;
		const baseValue = args[argIndex++];

		// Evaluate WHEN/THEN clauses
		for (const _clause of plan.whenThenClauses) {
			const whenValue = args[argIndex++];
			const thenValue = args[argIndex++];

			const conditionMet = baseValue !== null && whenValue !== null &&
				compareSqlValues(baseValue as SqlValue, whenValue) === 0;

			if (conditionMet) {
				return thenValue;
			}
		}

		// No WHEN clause matched, return ELSE value or NULL
		if (plan.elseExpr) {
			return args[argIndex]; // ELSE value
		} else {
			return null; // No ELSE clause, return NULL
		}
	}

	// Searched CASE: CASE WHEN condition1 THEN result1 WHEN condition2 THEN result2 ... END
	function runSearchedCase(
		runtimeCtx: RuntimeContext,
		...args: SqlValue[]
	): SqlValue {
		let argIndex = 0;

		// Evaluate WHEN/THEN clauses
		for (const _clause of plan.whenThenClauses) {
			const whenValue = args[argIndex++];
			const thenValue = args[argIndex++];

			if (isTruthy(whenValue)) {
				return thenValue;
			}
		}

		// No WHEN clause matched, return ELSE value or NULL
		if (plan.elseExpr) {
			return args[argIndex]; // ELSE value
		} else {
			return null; // No ELSE clause, return NULL
		}
	}

	// Emit instructions for all sub-expressions
	const paramInstructions: Instruction[] = [];

	if (plan.baseExpr) {
		paramInstructions.push(emitPlanNode(plan.baseExpr, ctx));
	}

	// TODO: consider making all of these calls for short-circuiting

	for (const clause of plan.whenThenClauses) {
		paramInstructions.push(emitPlanNode(clause.when, ctx));
		paramInstructions.push(emitPlanNode(clause.then, ctx));
	}

	if (plan.elseExpr) {
		paramInstructions.push(emitPlanNode(plan.elseExpr, ctx));
	}

	return {
		params: paramInstructions,
		run: (plan.baseExpr ? runSimpleCase : runSearchedCase) as InstructionRun,
		note: `case(${plan.whenThenClauses.length} when clauses${plan.elseExpr ? ', else' : ''})`
	};
}
