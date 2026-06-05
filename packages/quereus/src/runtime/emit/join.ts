import type { JoinNode } from '../../planner/nodes/join-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';

import { createRowSlot } from '../context-helpers.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:join');

/**
 * Emits a nested loop join instruction.
 * This is a simple nested loop implementation for inner/left/cross joins.
 */
export function emitLoopJoin(plan: JoinNode, ctx: EmissionContext): Instruction {
	// Create row descriptors for left and right inputs
	const leftAttributes = plan.left.getAttributes();
	const leftRowDescriptor = buildRowDescriptor(leftAttributes);

	const rightAttributes = plan.right.getAttributes();
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve USING column indices and collation-based comparators at emit time
	const usingResolved = plan.usingColumns?.map(columnName => {
		const lowerName = columnName.toLowerCase();
		const leftIndex = leftAttributes.findIndex(attr => attr.name.toLowerCase() === lowerName);
		const rightIndex = rightAttributes.findIndex(attr => attr.name.toLowerCase() === lowerName);
		const leftType = leftAttributes[leftIndex]?.type;
		const collationFunc = leftType?.collationName ? ctx.resolveCollation(leftType.collationName) : BINARY_COLLATION;
		return { leftIndex, rightIndex, collationFunc };
	});

	// Existence (`exists … as`) flags appended after both sides. The flag is the
	// ACTUAL match bit the outer-join null-extension already computes (NOT a
	// re-evaluation of the ON predicate, which would be unsound on a null-extended
	// row): a matched row has every side present (all flags true); a null-extended
	// row's non-preserved side is absent (its flag false; the preserved side stays
	// true). Pre-compute the two flag rows once at emit time.
	const existence = plan.existence;
	const matchedFlags: Row | undefined = existence ? existence.map(() => true) as Row : undefined;
	const unmatchedFlags: Row | undefined = existence ? existence.map(spec => spec.side === 'left') as Row : undefined;

	// NOTE: rightSource must be re-startable (optimizer facilitates through cache node)
	async function* run(rctx: RuntimeContext, leftSource: AsyncIterable<Row>, rightCallback: (ctx: RuntimeContext) => AsyncIterable<Row>, conditionCallback?: (ctx: RuntimeContext) => OutputValue): AsyncIterable<Row> {
		const joinType = plan.joinType;
		const isSemiOrAnti = joinType === 'semi' || joinType === 'anti';

		log('Starting %s join between %d left attrs and %d right attrs',
			joinType.toUpperCase(), leftAttributes.length, rightAttributes.length);

		if (joinType === 'right' || joinType === 'full') {
			throw new QuereusError(
				`${joinType.toUpperCase()} JOIN is not supported yet`,
				StatusCode.UNSUPPORTED
			);
		}

		// Create row slots for efficient context management
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// Process left side and join with right (pure streaming)
			for await (const leftRow of leftSource) {
				// Set up left context
				leftSlot.set(leftRow);

				let leftMatched = false;

				// Stream through right side for each left row
				for await (const rightRow of rightCallback(rctx)) {
					// Set up right context
					rightSlot.set(rightRow);

					// Evaluate join condition
					let conditionMet = true;

					if (conditionCallback) {
						// Evaluate the join condition using the callback provided by scheduler
						const conditionResult = await conditionCallback(rctx);
						conditionMet = !!conditionResult; // Convert to boolean
					} else if (usingResolved) {
						// Handle USING condition with pre-resolved indices and typed comparators
						conditionMet = evaluateUsingCondition(leftRow, rightRow, usingResolved);
					} else if (joinType === 'cross') {
						// Cross join - always true
						conditionMet = true;
					}

					if (conditionMet) {
						leftMatched = true;
						if (isSemiOrAnti) {
							// Semi: emit left row on first match and stop scanning right side
							// Anti: just record the match, don't emit yet
							break;
						}
						yield (matchedFlags ? [...leftRow, ...rightRow, ...matchedFlags] : [...leftRow, ...rightRow]) as Row;
					}
				}

				const postRow = joinOutputRow(joinType, leftMatched, isSemiOrAnti, leftRow, rightAttributes.length, rightSlot);
				if (postRow) yield (unmatchedFlags ? [...postRow, ...unmatchedFlags] : postRow) as Row;
			}

		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitCallFromPlan(plan.right, ctx);

	// Build the params array - include condition callback if present
	const params = [leftInstruction, rightInstruction];
	if (plan.condition) {
		const conditionInstruction = emitCallFromPlan(plan.condition, ctx);
		params.push(conditionInstruction);
	}

	return {
		params,
		run: run as InstructionRun,
		note: `${plan.joinType} join (nested loop)`
	};
}

type ResolvedUsingColumn = {
	leftIndex: number;
	rightIndex: number;
	collationFunc: (a: string, b: string) => number;
};

/**
 * Evaluates USING condition using pre-resolved column indices and collation functions.
 * All index lookups and collation resolution are done at emit time.
 * Uses compareSqlValuesFast for safe cross-type comparison.
 */
function evaluateUsingCondition(
	leftRow: Row,
	rightRow: Row,
	resolved: readonly ResolvedUsingColumn[]
): boolean {
	for (const { leftIndex, rightIndex, collationFunc } of resolved) {
		if (leftIndex === -1 || rightIndex === -1) {
			return false;
		}
		if (compareSqlValuesFast(leftRow[leftIndex], rightRow[rightIndex], collationFunc) !== 0) {
			return false;
		}
	}
	return true;
}
