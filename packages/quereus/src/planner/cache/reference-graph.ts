/**
 * Reference graph builder for materialization advisory
 * Analyzes plan tree to identify nodes that would benefit from caching
 *
 * Note: This builder works with logical plan nodes and their properties.
 * It does not make assumptions about execution strategies (e.g., whether
 * a join will use nested loops vs bloom/hash join). Loop detection and execution
 * multipliers should be determined during physical optimization when
 * concrete execution strategies are chosen.
 */

import { createLogger } from '../../common/logger.js';
import { isRelationalNode, type PlanNode } from '../nodes/plan-node.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';

const log = createLogger('optimizer:cache:reference-graph');

/**
 * Statistics about how a node is referenced in the plan tree
 */
export interface RefStats {
	/** Number of parent nodes referencing this node */
	parentCount: number;
	/** Whether this node appears on the inner side of a nested loop or correlated subquery */
	appearsInLoop: boolean;
	/** Estimated number of rows this node produces */
	estimatedRows: number;
	/** Whether this node is deterministic (same inputs produce same outputs) */
	deterministic: boolean;
	/** Parent nodes that reference this node (for debugging) */
	parents: Set<PlanNode>;
	/** Estimated execution multiplier due to loop contexts */
	loopMultiplier: number;
}

/**
 * Node traversal context
 */
interface TraversalContext {
	/** Current parent node */
	parent: PlanNode | null;
	/** Whether we're in a loop context */
	inLoop: boolean;
	/** Estimated loop iteration count */
	loopIterations: number;
}

/**
 * Builds a reference graph for materialization decisions
 */
export class ReferenceGraphBuilder {
	private refMap = new Map<PlanNode, RefStats>();

	constructor(private tuning: OptimizerTuning) {}

	/**
	 * Build reference statistics for all nodes in the plan tree
	 */
	buildReferenceGraph(root: PlanNode): Map<PlanNode, RefStats> {
		if (!root) {
			log('Warning: buildReferenceGraph called with null root');
			return new Map();
		}

		this.refMap.clear();

		// Build the reference graph with proper parent tracking
		const context: TraversalContext = {
			parent: null,
			inLoop: false,
			loopIterations: 1
		};

		this.buildReferences(root, context);

		log('Built reference graph with %d nodes', this.refMap.size);
		return new Map(this.refMap);
	}

	/**
	 * Build reference statistics recursively
	 */
	private buildReferences(node: PlanNode | null | undefined, context: TraversalContext): void {
		if (!node) {
			return;
		}

		// Get or create stats for this node
		let stats = this.refMap.get(node);
		if (!stats) {
			// First time seeing this node
			stats = {
				parentCount: 0,
				appearsInLoop: context.inLoop,
				estimatedRows: this.getEstimatedRows(node),
				deterministic: this.isDeterministic(node),
				parents: new Set<PlanNode>(),
				loopMultiplier: context.loopIterations
			};
			this.refMap.set(node, stats);
		}

		// Update stats based on current traversal
		if (context.parent && !stats.parents.has(context.parent)) {
			stats.parents.add(context.parent);
			stats.parentCount++;
		}

		// Update loop context
		if (context.inLoop) {
			stats.appearsInLoop = true;
			stats.loopMultiplier = Math.max(stats.loopMultiplier, context.loopIterations);
		}

		// Create child context - for now, we propagate the parent context
		// In the future, if nodes expose execution strategy hints, we could use those
		const childContext: TraversalContext = {
			parent: node,
			inLoop: context.inLoop,
			loopIterations: context.loopIterations
		};

		// Visit all children uniformly
		this.visitAllChildren(node, childContext);
	}

	/**
	 * Visit all children of a node
	 */
	private visitAllChildren(node: PlanNode, childContext: TraversalContext): void {
		// 1. Scalar children (expressions)
		try {
			const children = node.getChildren();
			for (const child of children) {
				if (child) {
					this.buildReferences(child, childContext);
				}
			}
		} catch (e) {
			log('Warning: Failed to get children for node %s: %s', node.nodeType, e);
		}

		// 2. Relational children
		// Note: getRelations() returns a subset of getChildren() for nodes that have relational children
		// We need to be careful not to double-count, but since we're using a Set for parents,
		// and checking if we've already added a parent, this should be fine
		if (isRelationalNode(node)) {
			try {
				const relations = node.getRelations();
				for (const relation of relations) {
					if (relation) {
						// For now, treat all relational children the same
						// In the future, nodes could provide hints about execution patterns
						this.buildReferences(relation, childContext);
					}
				}
			} catch (e) {
				log('Warning: Failed to get relations for node %s: %s', node.nodeType, e);
			}
		}
	}

	/**
	 * Get estimated row count for a node
	 */
	private getEstimatedRows(node: PlanNode | null | undefined): number {
		if (!node) {
			return this.tuning.defaultRowEstimate;
		}

		// Use physical properties if available
		if (node.physical?.estimatedRows !== undefined) {
			return node.physical.estimatedRows;
		}

		// Fall back to node-specific estimates (for relational nodes)
		if (isRelationalNode(node) && node.estimatedRows !== undefined) {
			return node.estimatedRows;
		}

		// Default estimate
		return this.tuning.defaultRowEstimate;
	}

	/**
	 * Determine if a node is deterministic
	 */
	private isDeterministic(node: PlanNode | null | undefined): boolean {
		if (!node) {
			return true;
		}

		// Use physical properties to determine determinism
		return node.physical?.deterministic ?? true;
	}
}
