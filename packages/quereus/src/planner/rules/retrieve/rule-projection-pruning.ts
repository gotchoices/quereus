/**
 * Rule: Projection Pruning
 *
 * When an outer ProjectNode references only a subset of an inner ProjectNode's
 * output attributes, the inner projections that are not referenced can be removed.
 *
 * This commonly arises after view expansion:
 *   Project(outer: name) → Project(view: id, name, email, category, value) → Scan
 * becomes:
 *   Project(outer: name) → Project(view: name) → Scan
 *
 * The rule only fires on ProjectNode whose source is also a ProjectNode.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:projection-pruning');

/**
 * Collect all attribute IDs referenced by ColumnReferenceNode leaves
 * within a scalar expression tree.
 */
function collectReferencedAttributeIds(node: PlanNode, out: Set<number>): void {
	if (node instanceof ColumnReferenceNode) {
		out.add(node.attributeId);
		return;
	}
	for (const child of node.getChildren()) {
		collectReferencedAttributeIds(child, out);
	}
}

export function ruleProjectionPruning(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const outer = node;
	if (!(outer.source instanceof ProjectNode)) return null;

	const inner = outer.source;

	// Collect attribute IDs the outer project's expressions reference
	const referencedIds = new Set<number>();
	for (const proj of outer.projections) {
		collectReferencedAttributeIds(proj.node, referencedIds);
	}

	// Determine which inner projections are referenced
	const innerAttrs = inner.getAttributes();
	const keptIndices: number[] = [];
	for (let i = 0; i < inner.projections.length; i++) {
		if (referencedIds.has(innerAttrs[i].id)) {
			keptIndices.push(i);
		}
	}

	// Nothing to prune
	if (keptIndices.length === inner.projections.length) return null;

	// Don't prune to zero projections — keep at least one
	if (keptIndices.length === 0) return null;

	// Refuse to drop any projection whose scalar expression carries a write —
	// pruning a side-effect-bearing computed column would silently skip the
	// write the user wrote into the projection list. (Detected at the projection
	// node level; the projection's scalar may be a relational subquery whose
	// readonly flag propagates up the AND-of-children.)
	for (let i = 0; i < inner.projections.length; i++) {
		if (keptIndices.includes(i)) continue;
		if (PlanNodeCharacteristics.subtreeHasSideEffects(inner.projections[i].node)) {
			log('projection-pruning skipped: dropped projection %s has side effects', inner.projections[i].alias);
			return null;
		}
	}

	log(
		'Pruning inner project from %d to %d projections',
		inner.projections.length,
		keptIndices.length
	);

	// Build pruned inner projections preserving attribute IDs
	const keptProjections = keptIndices.map(i => ({
		node: inner.projections[i].node,
		alias: inner.projections[i].alias,
		attributeId: innerAttrs[i].id,
	}));

	const keptAttributes = keptIndices.map(i => innerAttrs[i]);

	const prunedInner = new ProjectNode(
		inner.scope,
		inner.source,
		keptProjections,
		undefined,
		keptAttributes,
		inner.preserveInputColumns
	);

	// Rebuild outer project with new source
	const outerAttrs = outer.getAttributes();
	const newOuterProjections = outer.projections.map((proj, i) => ({
		node: proj.node as ScalarPlanNode,
		alias: proj.alias,
		attributeId: outerAttrs[i].id,
	}));

	return new ProjectNode(
		outer.scope,
		prunedInner,
		newOuterProjections,
		undefined,
		outerAttrs,
		outer.preserveInputColumns
	);
}
