/**
 * Rule: Join Physical Selection
 *
 * Required Characteristics:
 * - Node must be a logical JoinNode (not already a physical join)
 * - Node must have an equi-join predicate for hash/merge join consideration
 *
 * Applied When:
 * - Logical JoinNode with equi-join predicates where hash or merge join is cheaper than nested loop
 *
 * Benefits: Replaces O(n*m) nested loop with O(n+m) hash/merge join for equi-joins
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, RelationalPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { BloomJoinNode, type EquiJoinPair } from '../../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../nodes/merge-join-node.js';
import { SortNode } from '../../nodes/sort.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { nestedLoopJoinCost, hashJoinCost, mergeJoinCost } from '../../cost/index.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:join-physical-selection');

/**
 * Extract equi-join pairs and residual predicates from an ON condition.
 * Returns null if no equi-pairs found.
 */
function extractEquiPairs(
	condition: ScalarPlanNode | undefined,
	leftAttrIds: Set<number>,
	rightAttrIds: Set<number>
): { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null {
	if (!condition) return null;

	const norm = normalizePredicate(condition);
	const equiPairs: EquiJoinPair[] = [];
	const residuals: ScalarPlanNode[] = [];

	// Walk AND-tree and classify each conjunct
	const stack: ScalarPlanNode[] = [norm];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}

		// Check for equi-join: col_ref = col_ref across left/right
		let isEqui = false;
		if (n instanceof BinaryOpNode && n.expression.operator === '=') {
			if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode) {
				const lId = n.left.attributeId;
				const rId = n.right.attributeId;

				if (leftAttrIds.has(lId) && rightAttrIds.has(rId)) {
					equiPairs.push({ leftAttrId: lId, rightAttrId: rId });
					isEqui = true;
				} else if (leftAttrIds.has(rId) && rightAttrIds.has(lId)) {
					equiPairs.push({ leftAttrId: rId, rightAttrId: lId });
					isEqui = true;
				}
			}
		}

		if (!isEqui) {
			residuals.push(n);
		}
	}

	if (equiPairs.length === 0) return null;

	// Combine residuals back into an AND-tree
	let residual: ScalarPlanNode | undefined;
	if (residuals.length > 0) {
		residual = residuals.reduce((acc, cur) =>
			new BinaryOpNode(
				cur.scope,
				{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
				acc,
				cur
			)
		);
	}

	return { equiPairs, residual };
}

/**
 * Check if a source's ordering covers the given equi-pair columns.
 * Returns true if the source is already sorted ascending on the equi-pair
 * columns in the exact order the equi-pairs specify.  Positional matching
 * is required because the merge-join emitter compares keys in equi-pair
 * order; a mismatch (e.g. source sorted (b, a) vs equi-pairs (a, b))
 * would break the linear-scan invariant.
 */
function isOrderedOnEquiPairs(
	source: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	side: 'left' | 'right'
): boolean {
	const ordering = PlanNodeCharacteristics.getOrdering(source);
	if (!ordering || ordering.length === 0) return false;
	if (equiPairs.length > ordering.length) return false;

	const attrs = source.getAttributes();

	for (let i = 0; i < equiPairs.length; i++) {
		const attrId = side === 'left' ? equiPairs[i].leftAttrId : equiPairs[i].rightAttrId;
		const idx = attrs.findIndex(a => a.id === attrId);
		if (idx === -1) return false;

		// Ordering entry at position i must match this equi-pair column and
		// must be ascending (merge join's compareKeys assumes ASC order).
		if (ordering[i].column !== idx || ordering[i].desc) return false;
	}

	return true;
}

/**
 * Reorder equi-pairs to match the left source's physical ordering prefix.
 * The merge-join emitter compares keys in equi-pair order, so the pairs
 * must align with both sources' sort order.  Returns null if the pairs
 * cannot be reordered to match both sides simultaneously.
 */
function reorderEquiPairsForMerge(
	equiPairs: readonly EquiJoinPair[],
	left: RelationalPlanNode,
	right: RelationalPlanNode
): EquiJoinPair[] | null {
	const leftOrdering = PlanNodeCharacteristics.getOrdering(left);
	if (!leftOrdering || leftOrdering.length < equiPairs.length) return null;

	const leftAttrs = left.getAttributes();

	// Build a map from left column index → equi-pair index
	const colToEqIdx = new Map<number, number>();
	for (let i = 0; i < equiPairs.length; i++) {
		const attrIdx = leftAttrs.findIndex(a => a.id === equiPairs[i].leftAttrId);
		if (attrIdx === -1) return null;
		colToEqIdx.set(attrIdx, i);
	}

	// Reorder to match the left ordering prefix
	const reordered: EquiJoinPair[] = [];
	for (let i = 0; i < equiPairs.length; i++) {
		const eqIdx = colToEqIdx.get(leftOrdering[i].column);
		if (eqIdx === undefined || leftOrdering[i].desc) return null;
		reordered.push(equiPairs[eqIdx]);
	}

	// Verify the reordered pairs also match the right source's ordering
	if (!isOrderedOnEquiPairs(right, reordered, 'right')) return null;

	return reordered;
}

/**
 * Create a SortNode that sorts a source on the equi-pair columns for this side.
 */
function createSortForEquiPairs(
	source: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	side: 'left' | 'right',
	scope: import('../../scopes/scope.js').Scope
): RelationalPlanNode {
	const attrs = source.getAttributes();
	const sortKeys = equiPairs.map(pair => {
		const attrId = side === 'left' ? pair.leftAttrId : pair.rightAttrId;
		const idx = attrs.findIndex(a => a.id === attrId);
		const attr = attrs[idx];
		// Create a ColumnReferenceNode for this attribute
		const colRef = new ColumnReferenceNode(
			scope,
			{ type: 'column', table: '', name: attr.name, schema: '' },
			attr.type,
			attr.id,
			idx
		);
		return {
			expression: colRef as ScalarPlanNode,
			direction: 'asc' as const,
			nulls: undefined
		};
	});
	return new SortNode(scope, source, sortKeys);
}

export function ruleJoinPhysicalSelection(node: PlanNode, _context: OptContext): PlanNode | null {
	// Guard: only apply to logical JoinNode, not already-physical nodes
	if (!(node instanceof JoinNode)) return null;

	const joinType = node.joinType;

	// Support INNER, LEFT, SEMI, and ANTI joins
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'semi' && joinType !== 'anti') return null;

	// Build attribute ID sets for left and right
	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const leftAttrIds = new Set(leftAttrs.map(a => a.id));
	const rightAttrIds = new Set(rightAttrs.map(a => a.id));

	// Try to extract equi-join pairs from condition (or USING)
	let extracted: { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null = null;

	if (node.condition) {
		extracted = extractEquiPairs(node.condition, leftAttrIds, rightAttrIds);
	} else if (node.usingColumns) {
		// Convert USING columns to equi-pairs
		const equiPairs: EquiJoinPair[] = [];
		for (const colName of node.usingColumns) {
			const lowerName = colName.toLowerCase();
			const leftAttr = leftAttrs.find(a => a.name.toLowerCase() === lowerName);
			const rightAttr = rightAttrs.find(a => a.name.toLowerCase() === lowerName);
			if (leftAttr && rightAttr) {
				equiPairs.push({ leftAttrId: leftAttr.id, rightAttrId: rightAttr.id });
			}
		}
		if (equiPairs.length > 0) {
			extracted = { equiPairs, residual: undefined };
		}
	}

	if (!extracted || extracted.equiPairs.length === 0) return null;

	// Cost comparison: nested loop vs hash join vs merge join
	const leftRows = node.left.estimatedRows ?? 100;
	const rightRows = node.right.estimatedRows ?? 100;

	const nlCost = nestedLoopJoinCost(leftRows, rightRows);

	// Hash join cost: build side is the smaller input
	const buildRows = Math.min(leftRows, rightRows);
	const probeRows = Math.max(leftRows, rightRows);
	const hashCostValue = hashJoinCost(buildRows, probeRows);

	// Merge join cost: depends on whether inputs are already sorted.
	// Try reordering equi-pairs to match the source orderings first.
	let mergeEquiPairs = extracted.equiPairs;
	let leftOrdered = isOrderedOnEquiPairs(node.left, mergeEquiPairs, 'left');
	let rightOrdered = isOrderedOnEquiPairs(node.right, mergeEquiPairs, 'right');
	if ((!leftOrdered || !rightOrdered) && mergeEquiPairs.length > 1) {
		const reordered = reorderEquiPairsForMerge(mergeEquiPairs, node.left, node.right);
		if (reordered) {
			mergeEquiPairs = reordered;
			leftOrdered = true;
			rightOrdered = true;
		}
	}
	const mergeCostValue = mergeJoinCost(leftRows, rightRows, !leftOrdered, !rightOrdered);

	// Pick the cheapest physical join algorithm
	type JoinAlgo = 'nested-loop' | 'hash' | 'merge';
	let bestAlgo: JoinAlgo = 'nested-loop';
	let bestCost = nlCost;

	if (hashCostValue < bestCost) {
		bestAlgo = 'hash';
		bestCost = hashCostValue;
	}
	if (mergeCostValue < bestCost) {
		bestAlgo = 'merge';
		bestCost = mergeCostValue;
	}

	if (bestAlgo === 'nested-loop') {
		log('Nested loop cheapest (nl=%.2f, hash=%.2f, merge=%.2f) for %d x %d rows',
			nlCost, hashCostValue, mergeCostValue, leftRows, rightRows);
		return null;
	}

	log('Selecting %s join (nl=%.2f, hash=%.2f, merge=%.2f) for %d x %d rows',
		bestAlgo, nlCost, hashCostValue, mergeCostValue, leftRows, rightRows);

	// Preserve attribute IDs from the logical JoinNode
	const preserveAttrs = node.getAttributes().slice() as Attribute[];

	if (bestAlgo === 'merge') {
		// Build merge join, inserting SortNodes if needed
		let leftSource: RelationalPlanNode = node.left;
		let rightSource: RelationalPlanNode = node.right;

		if (!leftOrdered) {
			leftSource = createSortForEquiPairs(node.left, mergeEquiPairs, 'left', node.scope);
			log('Inserted left sort for merge join');
		}
		if (!rightOrdered) {
			rightSource = createSortForEquiPairs(node.right, mergeEquiPairs, 'right', node.scope);
			log('Inserted right sort for merge join');
		}

		return new MergeJoinNode(
			node.scope,
			leftSource,
			rightSource,
			joinType,
			mergeEquiPairs,
			extracted.residual,
			preserveAttrs
		);
	}

	// Hash join path
	// Determine build and probe sides: build=smaller, probe=larger
	// For LEFT JOIN, the left side MUST remain the probe side to preserve
	// null-padding semantics (all left rows must appear in output).
	let probeSource = node.left;
	let buildSource = node.right;
	let equiPairs = extracted.equiPairs;

	// For INNER join, swap sides if left is smaller (becomes build side).
	// For LEFT/SEMI/ANTI, left must remain probe to preserve semantics.
	if (joinType === 'inner' && leftRows < rightRows) {
		// Swap: left becomes build, right becomes probe
		probeSource = node.right;
		buildSource = node.left;
		// Flip equi-pair directions
		equiPairs = extracted.equiPairs.map(p => ({
			leftAttrId: p.rightAttrId,
			rightAttrId: p.leftAttrId
		}));
	}

	return new BloomJoinNode(
		node.scope,
		probeSource,
		buildSource,
		joinType,
		equiPairs,
		extracted.residual,
		preserveAttrs
	);
}
