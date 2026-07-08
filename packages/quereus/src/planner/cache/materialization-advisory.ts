/**
 * Materialization advisory framework
 * Decides when and how to inject caching based on reference graph analysis
 */

import { createLogger } from '../../common/logger.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { CacheNode, type CacheStrategy } from '../nodes/cache-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { ReferenceGraphBuilder, type RefStats } from './reference-graph.js';
import { isCorrelatedSubquery } from './correlation-detector.js';

const log = createLogger('optimizer:cache:materialization');

/**
 * Cache recommendation for a specific node
 */
export interface CacheRecommendation {
	/** Whether to inject caching for this node */
	shouldCache: boolean;
	/** Recommended cache strategy */
	strategy: CacheStrategy;
	/** Recommended cache threshold */
	threshold: number;
	/** Reason for the recommendation (for debugging) */
	reason: string;
}

/**
 * Materialization advisory that analyzes plan trees and recommends caching
 */
export class MaterializationAdvisory {
	private referenceBuilder: ReferenceGraphBuilder;

	constructor(private tuning: OptimizerTuning) {
		this.referenceBuilder = new ReferenceGraphBuilder(tuning);
	}

	/**
	 * Analyze a plan tree and inject caching where beneficial
	 * Returns the transformed tree or the original if no caching was added
	 */
	analyzeAndTransform(root: PlanNode): PlanNode {
		// Build reference graph
		const refGraph = this.referenceBuilder.buildReferenceGraph(root);

		// Build recommendations
		const recommendations = new Map<PlanNode, CacheRecommendation>();

		for (const [node, stats] of refGraph) {
			// Only consider relational nodes for caching
			if (!isRelationalNode(node)) {
				continue;
			}

			const recommendation = this.adviseCaching(node, stats);
			if (recommendation.shouldCache) {
				recommendations.set(node, recommendation);
				log('Recommending cache for %s: %s', node.nodeType, recommendation.reason);
			}
		}

		if (recommendations.size === 0) {
			log('No caching opportunities identified');
			return root;
		}

		log('Found %d caching opportunities', recommendations.size);

		// Transform the tree by wrapping recommended nodes with CacheNode
		return this.transformTree(root, recommendations);
	}

	/**
	 * Core advisory algorithm
	 */
	private adviseCaching(node: PlanNode, stats: RefStats): CacheRecommendation {
		// Rule 1: Non-deterministic nodes should not be cached
		if (!stats.deterministic) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Non-deterministic node'
			};
		}

		// Rule 2: Nodes that are already cached don't need additional caching
		if (node.nodeType === PlanNodeType.Cache) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Already cached'
			};
		}

		// Rule 3: Correlated subqueries should not be cached
		// Check if this node is part of a subquery context and if it's correlated
		if (isRelationalNode(node) && this.isCorrelatedNode(node)) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Correlated subquery - must re-execute for each outer row'
			};
		}

		// Rule 4: Single-parent nodes that don't appear in loops typically don't benefit from caching
		if (stats.parentCount <= 1 && !stats.appearsInLoop) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Single parent, not in loop'
			};
		}

		// Rule 5: Multi-parent nodes benefit from caching
		if (stats.parentCount > 1) {
			const strategy = this.selectStrategy(stats.estimatedRows);
			const threshold = this.calculateThreshold(stats.estimatedRows, strategy);

			return {
				shouldCache: true,
				strategy,
				threshold,
				reason: `Multiple parents (${stats.parentCount})`
			};
		}

		// Rule 6: Nodes in loop contexts benefit from caching even with single parent
		if (stats.appearsInLoop) {
			// Check if the estimated size is reasonable for caching
			if (stats.estimatedRows > this.tuning.join.maxRightRowsForCaching) {
				return {
					shouldCache: false,
					strategy: 'memory',
					threshold: 0,
					reason: `In loop but too large (${stats.estimatedRows} rows)`
				};
			}

			const strategy = this.selectStrategy(stats.estimatedRows);
			const threshold = this.calculateThreshold(stats.estimatedRows, strategy);

			return {
				shouldCache: true,
				strategy,
				threshold,
				reason: 'Appears in loop context'
			};
		}

		// Default: no caching
		return {
			shouldCache: false,
			strategy: 'memory',
			threshold: 0,
			reason: 'No caching criteria met'
		};
	}

	/**
	 * Select appropriate cache strategy based on estimated size
	 */
	private selectStrategy(estimatedRows: number): CacheStrategy {
		// Use tuning configuration for strategy selection
		if (this.tuning.cache.spillEnabled && estimatedRows > this.tuning.cache.spillThreshold) {
			return 'spill';
		}

		return 'memory';
	}

	/**
	 * Calculate appropriate cache threshold
	 */
	private calculateThreshold(estimatedRows: number, strategy: CacheStrategy): number {
		const multiplier = this.tuning.join.cacheThresholdMultiplier;
		const maxThreshold = strategy === 'spill' ?
			this.tuning.join.maxCacheThreshold * 2 : // Allow larger thresholds for spill
			this.tuning.join.maxCacheThreshold;

		return Math.min(
			Math.max(estimatedRows * multiplier, 1000), // Minimum threshold
			maxThreshold
		);
	}

	/**
	 * Check if a node is part of a correlated subquery
	 */
	private isCorrelatedNode(node: PlanNode): boolean {
		// Check if this is a relational node that could be correlated
		if (isRelationalNode(node)) {
			return isCorrelatedSubquery(node as RelationalPlanNode);
		}
		return false;
	}

	/**
	 * Transform a tree by wrapping recommended nodes with CacheNode
	 * Uses a bottom-up approach to ensure proper transformation
	 */
	private transformTree(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// First, transform all children recursively
		const transformedNode = this.transformChildren(node, recommendations);

		// Then check if this node itself should be cached
		const recommendation = recommendations.get(node);
		if (recommendation?.shouldCache && isRelationalNode(transformedNode)) {
			log('Injecting %s cache for %s (threshold: %d)',
				recommendation.strategy, transformedNode.nodeType, recommendation.threshold);

			return new CacheNode(
				transformedNode.scope,
				transformedNode as RelationalPlanNode,
				recommendation.strategy,
				recommendation.threshold
			);
		}

		return transformedNode;
	}

	/**
	 * Recurse into every child of a node and splice back any rewritten children.
	 */
	private transformChildren(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// getChildren() is the full child set — scalar AND relational
		// (getRelations ⊆ getChildren). Recurse into every child; if any comes
		// back wrapped in a CacheNode (or otherwise rewritten), splice the new
		// children back in via withChildren.
		const children = node.getChildren();
		const transformedChildren = children.map(child =>
			this.transformTree(child, recommendations)
		);

		const childrenChanged = transformedChildren.some((child, idx) =>
			child !== children[idx]
		);

		if (childrenChanged) {
			// Let withChildren handle the transformation
			// This will maintain proper attribute IDs and node structure
			// NOTE: this catch degrades to "no caching for this subtree" (returns
			// the untransformed node, dropping every CacheNode under it) rather
			// than propagating like reference-graph does. Kept swallowing because
			// it's perf-only — an uncached subtree still computes correct results —
			// so a withChildren quirk shouldn't fail planning. If missed caching
			// ever needs to be a hard error, promote this to a throw.
			try {
				return node.withChildren(transformedChildren);
			} catch (e) {
				// If withChildren fails, log and return original
				log('Warning: withChildren failed for %s: %s', node.nodeType, e);
				return node;
			}
		}

		// Nothing under this node changed. Because getChildren() already includes
		// relational children, any recommended CacheNode deeper in the tree was
		// spliced in via the withChildren branch above and propagated up — there
		// are no untransformed relational children left for other rules to handle.
		// Return the node unchanged.
		return node;
	}
}
