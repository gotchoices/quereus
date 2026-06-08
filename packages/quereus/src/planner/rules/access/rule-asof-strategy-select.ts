/**
 * Rule: AsofScan strategy selection (hash → merge).
 *
 * Promotes an `AsofScanNode` from the default `'hash'` strategy to the
 * co-streaming `'merge'` strategy when:
 *
 *   - Both children advertise `physical.ordering` whose leading
 *     `partitionAttrs.length + 1` entries form `[partition cols..., matchAttr]`.
 *   - At each partition position, left and right's attribute IDs pair up via
 *     a `partitionAttrs` equi-pair, in the same direction on both sides.
 *   - The trailing match-attr ordering on each side is ASC. The merge emitter
 *     walks both inputs forward — `direction='desc'` (latest right ≤ left)
 *     accumulates the largest qualifier seen; `direction='asc'` (earliest
 *     right ≥ left) returns the first qualifier. Both forms assume ASC sort
 *     on the matchAttr; that aligns with how access-path `monotonicOn` is
 *     advertised today (always ascending).
 *   - The right's estimated row count meets the configured
 *     `tuning.asof.mergeRowThreshold` — below it, hash's constant factors win.
 *
 * Bails to `null` (leaving the hash strategy) on any failure.
 *
 * The merge strategy streams memory O(1) and emits as left rows arrive,
 * unlike the hash variant's O(R) buffering and full-right-arrival latency.
 * Cost is O(L + R) for both — only constant factors differ — so this is a
 * predicate-driven rewrite rather than enumerate-and-cost.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { AsofScanNode } from '../../nodes/asof-scan-node.js';

const log = createLogger('optimizer:rule:asof-strategy-select');

interface OrderingEntry {
	attrId: number;
	desc: boolean;
}

/**
 * Translate the leading `prefixLen` ordering entries on a child to
 * (attrId, desc) pairs. Returns null when the ordering is shorter than
 * required or contains entries that do not map to a known attribute.
 */
function mapLeadingOrdering(
	ordering: readonly { column: number; desc: boolean }[] | undefined,
	attrs: readonly { id: number }[],
	prefixLen: number,
): OrderingEntry[] | null {
	if (!ordering || ordering.length < prefixLen) return null;
	const out: OrderingEntry[] = [];
	for (let i = 0; i < prefixLen; i++) {
		const entry = ordering[i];
		const attr = attrs[entry.column];
		if (!attr) return null;
		out.push({ attrId: attr.id, desc: entry.desc });
	}
	return out;
}

export function ruleAsofStrategySelect(node: PlanNode, ctx: OptContext): PlanNode | null {
	if (!(node instanceof AsofScanNode)) return null;
	if (node.strategy !== 'hash') return null;

	const partitionLen = node.partitionAttrs.length;
	const prefixLen = partitionLen + 1;

	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();

	const leftOrdering = mapLeadingOrdering(node.left.physical.ordering, leftAttrs, prefixLen);
	if (!leftOrdering) {
		log('Left does not provide a long enough ordering prefix (need %d)', prefixLen);
		return null;
	}
	const rightOrdering = mapLeadingOrdering(node.right.physical.ordering, rightAttrs, prefixLen);
	if (!rightOrdering) {
		log('Right does not provide a long enough ordering prefix (need %d)', prefixLen);
		return null;
	}

	// Partition prefix: at each ordering position, left's attr-id must be the
	// `leftAttrId` of one of the partition pairs; the same position on the
	// right must carry the corresponding `rightAttrId`. Directions must match.
	const remainingPairs = node.partitionAttrs.slice();
	for (let i = 0; i < partitionLen; i++) {
		const leftEntry = leftOrdering[i];
		const rightEntry = rightOrdering[i];
		if (leftEntry.desc !== rightEntry.desc) {
			log('Direction mismatch at partition position %d (left=%s, right=%s)',
				i, leftEntry.desc ? 'desc' : 'asc', rightEntry.desc ? 'desc' : 'asc');
			return null;
		}
		const pairIdx = remainingPairs.findIndex(p =>
			p.leftAttrId === leftEntry.attrId && p.rightAttrId === rightEntry.attrId);
		if (pairIdx < 0) {
			log('Position %d (left=%d, right=%d) does not pair via partitionAttrs',
				i, leftEntry.attrId, rightEntry.attrId);
			return null;
		}
		remainingPairs.splice(pairIdx, 1);
	}

	// Trailing entry on each side must be the asof match attribute, ASC.
	// The merge emitter walks both inputs forward; that requires ascending
	// match-attr ordering on both sides regardless of the asof direction.
	const tailLeft = leftOrdering[partitionLen];
	const tailRight = rightOrdering[partitionLen];
	if (tailLeft.attrId !== node.matchAttr.leftAttrId) {
		log('Left ordering tail (attr=%d) is not the match attr (attr=%d)',
			tailLeft.attrId, node.matchAttr.leftAttrId);
		return null;
	}
	if (tailRight.attrId !== node.matchAttr.rightAttrId) {
		log('Right ordering tail (attr=%d) is not the match attr (attr=%d)',
			tailRight.attrId, node.matchAttr.rightAttrId);
		return null;
	}
	if (tailLeft.desc || tailRight.desc) {
		log('Match-attr ordering must be ASC on both sides (left=%s, right=%s)',
			tailLeft.desc ? 'desc' : 'asc',
			tailRight.desc ? 'desc' : 'asc');
		return null;
	}

	// Threshold gate.
	const tuning = ctx.tuning;
	const rightRows = node.right.estimatedRows ?? tuning.defaultRowEstimate;
	if (rightRows < tuning.asof.mergeRowThreshold) {
		log('Right estimated rows (%d) below merge threshold (%d); keeping hash',
			rightRows, tuning.asof.mergeRowThreshold);
		return null;
	}

	log('Promoting AsofScan to merge strategy (rightRows=%d, partitionCols=%d)',
		rightRows, partitionLen);
	return node.withStrategy('merge');
}
