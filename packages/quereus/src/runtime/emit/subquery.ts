import type { InNode, ExistsNode, ScalarSubqueryNode } from '../../planner/nodes/subquery.js';
import type { Instruction, InstructionRun, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { SqlValue, Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'inheritree';
import { compareSqlValuesFast } from '../../util/comparison.js';
import { ConstantNode } from '../../planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../planner/framework/characteristics.js';

export function emitScalarSubquery(plan: ScalarSubqueryNode, ctx: EmissionContext): Instruction {
	const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery);

	if (isImpure) {
		// Impure inner (DML w/ RETURNING in scalar position):
		// - Fully drain the iterator so every write happens, not just the first.
		// - Memoize across re-evaluations (correlated outer, per-row scan) so
		//   the DML fires exactly once per statement execution. Closure state
		//   is per-emission and the Statement re-emits per execution, so this
		//   resets between prepared-statement runs.
		let memoized: { value: SqlValue } | null = null;

		async function runImpure(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
			if (memoized) return memoized.value;

			let result: SqlValue = null;
			let seen = false;

			for await (const row of input) {
				if (!seen) {
					if (row.length > 1) {
						throw new QuereusError('Subquery should return at most one column', StatusCode.ERROR);
					}
					result = row.length === 0 ? null : row[0];
					seen = true;
				}
				// Continue iterating to drive every write, even past the first row.
			}

			memoized = { value: result };
			return result;
		}

		const innerInstruction = emitPlanNode(plan.subquery, ctx);

		return {
			params: [innerInstruction],
			run: runImpure as InstructionRun,
			note: 'SCALAR_SUBQUERY(impure)'
		};
	}

	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		let result: SqlValue = null;
		let seen = false;

		for await (const row of input) {
			if (seen) {
				throw new QuereusError('Scalar subquery returned more than one row', StatusCode.ERROR, undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
			}
			if (row.length > 1) {
				throw new QuereusError('Subquery should return at most one column', StatusCode.ERROR);
			}
			result = row.length === 0 ? null : row[0];
			seen = true;
		}

		return result;
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run: run as InstructionRun,
		note: 'SCALAR_SUBQUERY'
	};
}

export function emitIn(plan: InNode, ctx: EmissionContext): Instruction {
	// Extract collation from the condition expression
	const conditionType = plan.condition.getType();
	const collationName = conditionType.collationName || 'BINARY';
	const collation = ctx.resolveCollation(collationName);

	if (plan.source) {
		const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.source);

		if (isImpure) {
			// Impure inner: fully drain (no short-circuit on match) so every
			// write fires, and memoize so re-evaluation does not re-drive the DML.
			let memoized: { value: SqlValue } | null = null;

			async function runImpure(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
				if (memoized) return memoized.value;

				let matched = false;
				let hasNull = false;
				const shouldCompare = condition !== null;

				for await (const row of input) {
					if (row.length > 0) {
						const rowValue = row[0];
						if (rowValue === null) {
							hasNull = true;
						} else if (shouldCompare && !matched && compareSqlValuesFast(condition, rowValue, collation) === 0) {
							matched = true;
						}
					}
					// Continue iterating to drive every write past the first match.
				}

				let result: SqlValue;
				if (!shouldCompare) {
					result = null;
				} else if (matched) {
					result = true;
				} else {
					result = hasNull ? null : false;
				}

				memoized = { value: result };
				return result;
			}

			const sourceInstruction = emitPlanNode(plan.source, ctx);
			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [sourceInstruction, conditionExpr],
				run: runImpure as InstructionRun,
				note: 'IN(impure)'
			};
		}

		// Pure subquery: streaming + early exit on match.
		async function runSubqueryStreaming(_rctx: RuntimeContext, input: AsyncIterable<Row>, condition: SqlValue): Promise<SqlValue> {
			// If condition is NULL, result is NULL
			if (condition === null) {
				return null;
			}

			let hasNull = false;
			for await (const row of input) {
				if (row.length > 0) {
					const rowValue = row[0];
					if (rowValue === null) {
						hasNull = true;
						continue;
					}
					// Check for match immediately - no need to materialize
					if (compareSqlValuesFast(condition, rowValue, collation) === 0) {
						return true; // Found a match
					}
				}
			}

			// No match found - if any value was NULL, result is NULL
			return hasNull ? null : false;
		}

		const sourceInstruction = emitPlanNode(plan.source, ctx);
		const conditionExpr = emitPlanNode(plan.condition, ctx);

		return {
			params: [sourceInstruction, conditionExpr],
			run: runSubqueryStreaming as InstructionRun,
			note: `IN (subquery)`
		};
	} else if (plan.values) {
		// IN value list: expr IN (value1, value2, ...)

		// Check if all values are truly constant (can be evaluated at emit time)
		const allConstant = plan.values.every(val => val.physical.constant);

		if (allConstant) {
			// Pre-build BTree at emit time for constant values
			const tree = new BTree<SqlValue, SqlValue>(
				(val: SqlValue) => val,
				(a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation)
			);
			let hasNull = false;

			function innerConstantRun(_rctx: RuntimeContext, condition: SqlValue): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Check if condition exists in pre-built tree
				const path = tree.find(condition);
				if (path.on) {
					return true; // Found a match
				}

				// No match found - if any value was NULL, result is NULL
				return hasNull ? null : false;
			}

			const values = plan.values.map(val => (val as unknown as ConstantNode).getValue());

			let runFunc: InstructionRun;

			if (values.some(val => val instanceof Promise)) {
				// Must resolve promises at runtime
				runFunc = (async (rctx: RuntimeContext, condition: SqlValue): Promise<SqlValue> => {
					const resolved = await Promise.all(values);

					for (const value of resolved) {
						if (value === null) {
							hasNull = true;
							continue;
						}
						tree.insert(value as SqlValue);
					}

					return innerConstantRun(rctx, condition);
				}) as InstructionRun;
			} else {
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					tree.insert(value as SqlValue);
				}
				runFunc = innerConstantRun as InstructionRun;
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);

			return {
				params: [conditionExpr],
				run: runFunc as InstructionRun,
				note: `IN (${plan.values.length} constant values)`
			};
		} else {
			// Some values are expressions - build tree at runtime
			function runDynamicValues(_rctx: RuntimeContext, condition: SqlValue, ...values: SqlValue[]): SqlValue {
				// If condition is NULL, result is NULL
				if (condition === null) {
					return null;
				}

				// Linear scan is optimal since we're only doing one lookup per execution
				let hasNull = false;
				for (const value of values) {
					if (value === null) {
						hasNull = true;
						continue;
					}
					if (compareSqlValuesFast(condition, value, collation) === 0) {
						return true; // Found a match
					}
				}

				// No match found - if any value was NULL, result is NULL
				return hasNull ? null : false;
			}

			const conditionExpr = emitPlanNode(plan.condition, ctx);
			const valueExprs = plan.values.map(val => emitPlanNode(val, ctx));

			return {
				params: [conditionExpr, ...valueExprs],
				run: runDynamicValues as InstructionRun,
				note: `IN (${plan.values.length} dynamic values)`
			};
		}
	} else {
		throw new QuereusError('IN node must have either source or values', StatusCode.INTERNAL);
	}
}

export function emitExists(plan: ExistsNode, ctx: EmissionContext): Instruction {
	const isImpure = PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery);

	if (isImpure) {
		// Impure inner: fully drain (no short-circuit) so every write fires,
		// and memoize so re-evaluation does not re-drive the DML.
		let memoized: { value: SqlValue } | null = null;

		async function runImpure(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
			if (memoized) return memoized.value;

			let any = false;
			for await (const _row of input) {
				any = true;
				// Continue iterating to drive every write past the first row.
			}

			const result: SqlValue = any;
			memoized = { value: result };
			return result;
		}

		const innerInstruction = emitPlanNode(plan.subquery, ctx);

		return {
			params: [innerInstruction],
			run: runImpure as InstructionRun,
			note: 'EXISTS(impure)'
		};
	}

	async function run(_rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<SqlValue> {
		for await (const _row of input) {
			return true; // First row => TRUE
		}
		return false; // Empty => FALSE
	}

	const innerInstruction = emitPlanNode(plan.subquery, ctx);

	return {
		params: [innerInstruction],
		run: run as InstructionRun,
		note: 'EXISTS'
	};
}
