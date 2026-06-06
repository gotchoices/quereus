/**
 * Rule: Materialization Advisory
 *
 * Required Characteristics:
 * - Node must be non-relational with relational children
 * - Children must be cacheable based on reference analysis
 * - Children must benefit from materialization
 *
 * Applied When:
 * - Transition from non-relational to relational subtrees
 * - Relational subtrees would benefit from caching
 *
 * Benefits: Reduces redundant computation for repeated scans and loop contexts
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { MaterializationAdvisory } from '../../cache/materialization-advisory.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:materialization-advisory');

export function ruleMaterializationAdvisory(node: PlanNode, context: OptContext): PlanNode | null {
	// Apply this rule when we're at a non-relational node that has relational children
	// This captures transitions into relational subtrees (queries, subqueries, CTEs, etc.)

	// Check if this is a non-relational node using characteristics
	if (PlanNodeCharacteristics.isRelational(node)) {
		// This is already a relational node, don't apply here
		return null;
	}

	// Check if this node has any relational children
	const relations = node.getRelations();
	if (relations.length === 0) {
		// No relational children, nothing to analyze
		return null;
	}

	log('Applying materialization advisory at transition from %s to relational children', node.getType().typeClass);

	try {
		// Create advisory with current tuning parameters
		const advisory = new MaterializationAdvisory(context.tuning);

		// We need to analyze and potentially transform each relational subtree
		let anyTransformed = false;

		// For each relational child, analyze and transform its entire subtree
		for (const relation of relations) {
			const transformedRelation = advisory.analyzeAndTransform(relation);
			if (transformedRelation !== relation) {
				anyTransformed = true;
				log('Transformed relational subtree under %s node', node.getType().typeClass);
			}
		}

		// If any relational children were transformed, we need to return a transformed node
		// However, since we can't easily reconstruct the parent node with new relational children
		// (as discussed in the earlier implementation), we'll analyze the entire node
		if (anyTransformed) {
			// Re-analyze the entire tree rooted at this node
			const fullTransform = advisory.analyzeAndTransform(node);
			if (fullTransform !== node) {
				return fullTransform;
			}
		}

		return null;

	} catch (error) {
		log('Error in materialization advisory: %s', error);
		// Don't fail optimization - just skip caching
		return null;
	}
}
