import type { MergeJoinNode } from '../../planner/nodes/merge-join-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';
import type { CollationFunction } from '../../util/comparison.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:merge-join');

/**
 * Compare two rows on the equi-join key columns.
 * Returns < 0 if left < right, 0 if equal, > 0 if left > right.
 * Returns null if either side has a NULL key (NULLs never match in equi-joins).
 */
function compareKeys(
	leftRow: Row,
	rightRow: Row,
	leftIndices: number[],
	rightIndices: number[],
	collations: CollationFunction[]
): number | null {
	for (let i = 0; i < leftIndices.length; i++) {
		const lv = leftRow[leftIndices[i]];
		const rv = rightRow[rightIndices[i]];
		if (lv === null || rv === null) return null;
		const cmp = compareSqlValuesFast(lv, rv, collations[i]);
		if (cmp !== 0) return cmp;
	}
	return 0;
}

/**
 * Emits a merge join instruction.
 *
 * Classic merge-join algorithm:
 * 1. Advance both iterators in sorted order
 * 2. When keys match, collect the "run" of equal keys from the right side
 * 3. Produce cross-product of matching left rows × right run
 * 4. LEFT JOIN: emit null-padded rows for left rows with no match
 */
export function emitMergeJoin(plan: MergeJoinNode, ctx: EmissionContext): Instruction {
	const leftAttributes = plan.left.getAttributes();
	const rightAttributes = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttributes);
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve equi-pair column indices and collation functions
	const leftIndices: number[] = [];
	const rightIndices: number[] = [];
	const collations: CollationFunction[] = [];
	const leftIndex = plan.left.getAttributeIndex();
	const rightIndex = plan.right.getAttributeIndex();
	for (const pair of plan.equiPairs) {
		const li = leftIndex.get(pair.leftAttrId) ?? -1;
		const ri = rightIndex.get(pair.rightAttrId) ?? -1;
		if (li === -1 || ri === -1) {
			throw new Error(`MergeJoin: could not resolve equi-pair attr IDs ${pair.leftAttrId}=${pair.rightAttrId}`);
		}
		leftIndices.push(li);
		rightIndices.push(ri);
		const collationName = leftAttributes[li].type.collationName || rightAttributes[ri].type.collationName;
		collations.push(collationName ? ctx.resolveCollation(collationName) : BINARY_COLLATION);
	}

	const rightColCount = rightAttributes.length;

	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
		residualCallback?: (ctx: RuntimeContext) => OutputValue
	): AsyncIterable<Row> {
		log('Starting %s merge join: %d equi-pairs', plan.joinType.toUpperCase(), plan.equiPairs.length);

		const isSemiOrAnti = plan.joinType === 'semi' || plan.joinType === 'anti';
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// Materialize right side into sorted array for run detection.
			// We need random access to handle duplicate key runs.
			const rightRows: Row[] = [];
			for await (const row of rightSource) {
				rightRows.push(row);
			}

			log('Right side materialized: %d rows', rightRows.length);

			let rightIdx = 0;

			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);
				let matched = false;

				// Check for NULL keys on the left side
				let leftHasNull = false;
				for (let i = 0; i < leftIndices.length; i++) {
					if (leftRow[leftIndices[i]] === null) {
						leftHasNull = true;
						break;
					}
				}

				if (leftHasNull) {
					// NULL keys never match; skip ahead
				} else {
					// Advance right pointer past rows that are less than the current left key
					while (rightIdx < rightRows.length) {
						const cmp = compareKeys(leftRow, rightRows[rightIdx], leftIndices, rightIndices, collations);
						if (cmp === null) {
							// Right row has NULL key — skip it
							rightIdx++;
							continue;
						}
						if (cmp <= 0) break; // right >= left, stop advancing
						rightIdx++;
					}

					// Collect the run of matching right rows
					let runStart = rightIdx;
					while (runStart < rightRows.length) {
						const cmp = compareKeys(leftRow, rightRows[runStart], leftIndices, rightIndices, collations);
						if (cmp !== 0) break; // No longer equal
						runStart++;
					}
					const runEnd = runStart; // runEnd is exclusive

					// Emit matches for [rightIdx, runEnd)
					for (let ri = rightIdx; ri < runEnd; ri++) {
						const rightRow = rightRows[ri];
						rightSlot.set(rightRow);

						// Evaluate residual condition if present
						if (residualCallback) {
							const result = await residualCallback(rctx);
							if (!result) continue;
						}

						matched = true;
						if (isSemiOrAnti) {
							break;
						}
						yield [...leftRow, ...rightRow] as Row;
					}
				}

				const postRow = joinOutputRow(plan.joinType, matched, isSemiOrAnti, leftRow, rightColCount, rightSlot);
				if (postRow) yield postRow;
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	const params = [leftInstruction, rightInstruction];
	if (plan.residualCondition) {
		const residualInstruction = emitCallFromPlan(plan.residualCondition, ctx);
		params.push(residualInstruction);
	}

	return {
		params,
		run: run as InstructionRun,
		note: `${plan.joinType} join (merge)`
	};
}
