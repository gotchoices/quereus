import type { Row } from '../../common/types.js';
import type { JoinType } from '../../planner/nodes/join-node.js';

/**
 * After scanning the right side for a given left row, determines what (if any)
 * row to yield for semi/anti/left join semantics.
 *
 * Returns the row to yield, or null if nothing should be yielded.
 * For LEFT JOIN unmatched rows, also sets the rightSlot to null padding.
 */
export function joinOutputRow(
	joinType: JoinType,
	matched: boolean,
	isSemiOrAnti: boolean,
	leftRow: Row,
	rightColCount: number,
	rightSlot: { set(row: Row): void },
): Row | null {
	if (isSemiOrAnti) {
		if ((joinType === 'semi' && matched) || (joinType === 'anti' && !matched)) {
			return leftRow;
		}
		return null;
	}
	if (!matched && joinType === 'left') {
		const nullPadding = new Array(rightColCount).fill(null) as Row;
		rightSlot.set(nullPadding);
		return [...leftRow, ...nullPadding] as Row;
	}
	return null;
}
