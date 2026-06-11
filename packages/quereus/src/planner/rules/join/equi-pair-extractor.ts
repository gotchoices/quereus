/**
 * Shared helper: extract equi-join pairs and residual predicate from an ON
 * condition. Used by both `rule-join-physical-selection` (ordering-based) and
 * `rule-monotonic-merge-join` (MonotonicOn-based).
 */

import type { ScalarPlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { EquiJoinPair } from '../../nodes/join-utils.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { operandCollation } from '../../analysis/comparison-collation.js';
import { normalizeCollationName } from '../../../util/comparison.js';

export interface EquiPairExtraction {
	equiPairs: EquiJoinPair[];
	residual: ScalarPlanNode | undefined;
	/**
	 * For each entry in `equiPairs`, the original `=` ScalarPlanNode it was
	 * extracted from (or `undefined` for USING-derived pairs that have no
	 * source node). Same length and order as `equiPairs`. Useful when a rule
	 * wants to demote a subset of equi-pairs back into the residual (e.g., the
	 * monotonic-merge rule keeps only the monotonic-driving pair as the merge
	 * key and pushes the rest into the residual).
	 */
	equiPairNodes: Array<ScalarPlanNode | undefined>;
}

/**
 * Check whether `source`'s `physical.ordering` covers the given equi-pair
 * columns positionally for the chosen `side` (the merge-join emitter compares
 * keys in equi-pair order, so the source must be ASC-sorted on each
 * equi-pair attribute at exactly that position). Returns false on the first
 * mismatch.
 */
export function isOrderedOnEquiPairs(
	source: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	side: 'left' | 'right',
): boolean {
	const ordering = PlanNodeCharacteristics.getOrdering(source);
	if (!ordering || ordering.length === 0) return false;
	if (equiPairs.length > ordering.length) return false;

	const attrIndex = source.getAttributeIndex();
	for (let i = 0; i < equiPairs.length; i++) {
		const attrId = side === 'left' ? equiPairs[i].leftAttrId : equiPairs[i].rightAttrId;
		const idx = attrIndex.get(attrId) ?? -1;
		if (idx === -1) return false;
		if (ordering[i].column !== idx || ordering[i].desc) return false;
	}
	return true;
}

/**
 * Reorder equi-pairs so they line up with the left source's ordering prefix,
 * and verify the right source agrees on the same reordered key sequence.
 * Returns null when no reordering can satisfy both sides simultaneously.
 */
export function reorderEquiPairsForMerge(
	equiPairs: readonly EquiJoinPair[],
	left: RelationalPlanNode,
	right: RelationalPlanNode,
): EquiJoinPair[] | null {
	const leftOrdering = PlanNodeCharacteristics.getOrdering(left);
	if (!leftOrdering || leftOrdering.length < equiPairs.length) return null;

	const leftAttrIndex = left.getAttributeIndex();
	const colToEqIdx = new Map<number, number>();
	for (let i = 0; i < equiPairs.length; i++) {
		const attrIdx = leftAttrIndex.get(equiPairs[i].leftAttrId) ?? -1;
		if (attrIdx === -1) return null;
		colToEqIdx.set(attrIdx, i);
	}

	const reordered: EquiJoinPair[] = [];
	for (let i = 0; i < equiPairs.length; i++) {
		const eqIdx = colToEqIdx.get(leftOrdering[i].column);
		if (eqIdx === undefined || leftOrdering[i].desc) return null;
		reordered.push(equiPairs[eqIdx]);
	}

	if (!isOrderedOnEquiPairs(right, reordered, 'right')) return null;
	return reordered;
}

/**
 * True when both sides' physical ordering covers ALL equi-pairs in the
 * exact (or reorderable) order required by the merge-join emitter. When this
 * holds the ordering-based rule will produce a multi-key merge join with
 * proper unique-key propagation; rules that demote pairs to residual should
 * defer to that path instead of taking a single-pair merge.
 */
export function isMergeReadyOnAllPairs(
	left: RelationalPlanNode,
	right: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
): boolean {
	if (isOrderedOnEquiPairs(left, equiPairs, 'left') && isOrderedOnEquiPairs(right, equiPairs, 'right')) {
		return true;
	}
	if (equiPairs.length > 1) {
		return reorderEquiPairsForMerge(equiPairs, left, right) !== null;
	}
	return false;
}

/** Combine an existing residual and a list of extra scalar conjuncts into a single AND-tree. */
export function combineResidual(
	base: ScalarPlanNode | undefined,
	extras: ReadonlyArray<ScalarPlanNode>,
): ScalarPlanNode | undefined {
	const all: ScalarPlanNode[] = [];
	if (base) all.push(base);
	for (const e of extras) all.push(e);
	if (all.length === 0) return undefined;
	if (all.length === 1) return all[0];
	return all.reduce((acc, cur) =>
		new BinaryOpNode(
			cur.scope,
			{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
			acc,
			cur
		)
	);
}

/**
 * Extract equi-join pairs and residual predicates from an ON condition.
 * Returns null if no equi-pairs are found.
 *
 * **Collation gate.** A `l = r` column pair is recognized only when both
 * columns contribute the same collation. The physical join algorithms this
 * extraction feeds (hash / merge / bloom) resolve the pair's comparison
 * collation themselves (left-operand precedence in their emitters), while the
 * canonical scalar comparison (`emitComparisonOp`, used by the nested-loop
 * fallback) resolves right-first — for an asymmetric pair (NOCASE column vs
 * BINARY column) the two would *disagree on the result rows*, and the join's
 * key-coverage claims (left keys survive when pairs cover a right key) would
 * be computed against whichever collation the algorithm happened to use. A
 * matched-collation pair is immune to resolution order, and its coverage
 * claims are sound (comparison collation = covered column's declared
 * collation = its key's enforcement collation). Mismatched pairs demote to
 * the residual, where the canonical scalar comparison evaluates them; if no
 * matched pair remains, the rule doesn't fire and the generic join evaluates
 * the whole condition. (Ticket `collation-blind-equality-fact-extraction`.)
 */
export function extractEquiPairs(
	condition: ScalarPlanNode | undefined,
	leftAttrIds: Set<number>,
	rightAttrIds: Set<number>
): EquiPairExtraction | null {
	if (!condition) return null;

	const norm = normalizePredicate(condition);
	const equiPairs: EquiJoinPair[] = [];
	const equiPairNodes: Array<ScalarPlanNode | undefined> = [];
	const residuals: ScalarPlanNode[] = [];

	const stack: ScalarPlanNode[] = [norm];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}

		let isEqui = false;
		if (n instanceof BinaryOpNode && n.expression.operator === '=') {
			if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode
				&& operandCollation(n.left) === operandCollation(n.right)) {
				const lId = n.left.attributeId;
				const rId = n.right.attributeId;

				if (leftAttrIds.has(lId) && rightAttrIds.has(rId)) {
					equiPairs.push({ leftAttrId: lId, rightAttrId: rId });
					equiPairNodes.push(n);
					isEqui = true;
				} else if (leftAttrIds.has(rId) && rightAttrIds.has(lId)) {
					equiPairs.push({ leftAttrId: rId, rightAttrId: lId });
					equiPairNodes.push(n);
					isEqui = true;
				}
			}
		}

		if (!isEqui) {
			residuals.push(n);
		}
	}

	if (equiPairs.length === 0) return null;

	const residual = combineResidual(undefined, residuals);

	return { equiPairs, residual, equiPairNodes };
}

/**
 * Convert USING-column names into equi-pairs given the left/right attributes.
 * Returns null if no pairs could be matched.
 *
 * Applies the same matched-collation gate as {@link extractEquiPairs}: a
 * USING pair over columns with differing declared collations is rejected
 * outright (USING has no residual to demote into — the whole extraction
 * returns null so the generic join handles the condition).
 */
export function extractEquiPairsFromUsing(
	usingColumns: readonly string[] | undefined,
	leftAttrs: ReadonlyArray<{ id: number; name: string; type?: { collationName?: string } }>,
	rightAttrs: ReadonlyArray<{ id: number; name: string; type?: { collationName?: string } }>,
): EquiPairExtraction | null {
	if (!usingColumns || usingColumns.length === 0) return null;
	const equiPairs: EquiJoinPair[] = [];
	for (const colName of usingColumns) {
		const lower = colName.toLowerCase();
		const leftAttr = leftAttrs.find(a => a.name.toLowerCase() === lower);
		const rightAttr = rightAttrs.find(a => a.name.toLowerCase() === lower);
		if (leftAttr && rightAttr) {
			const lColl = normalizeCollationName(leftAttr.type?.collationName ?? 'BINARY');
			const rColl = normalizeCollationName(rightAttr.type?.collationName ?? 'BINARY');
			if (lColl !== rColl) return null;
			equiPairs.push({ leftAttrId: leftAttr.id, rightAttrId: rightAttr.id });
		}
	}
	if (equiPairs.length === 0) return null;
	return { equiPairs, residual: undefined, equiPairNodes: equiPairs.map(() => undefined) };
}
