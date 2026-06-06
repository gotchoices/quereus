/**
 * Basic row and cost estimation utilities for plan nodes
 * Used when more sophisticated statistics are not available
 */

import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';

/**
 * Basic row estimation heuristics
 */
export class BasicRowEstimator {
	constructor(private readonly tuning: OptimizerTuning) {}

	/**
	 * Estimate rows for a filter operation
	 * Default assumes 30% selectivity for most predicates
	 */
	estimateFilter(sourceRows: number): number {
		return Math.max(1, Math.floor(sourceRows * 0.3));
	}

	/**
	 * Estimate rows for a join operation
	 */
	estimateJoin(leftRows: number, rightRows: number, joinType: string): number {
		switch (joinType.toLowerCase()) {
			case 'inner':
				// Inner join: assume moderate correlation
				return Math.max(1, Math.floor(leftRows * rightRows * 0.1));
			case 'left':
			case 'left outer':
				// Left join: at least as many as left side
				return Math.max(leftRows, Math.floor(leftRows * rightRows * 0.1));
			case 'right':
			case 'right outer':
				// Right join: at least as many as right side
				return Math.max(rightRows, Math.floor(leftRows * rightRows * 0.1));
			case 'full':
			case 'full outer':
				// Full outer join: at least max(left, right); heuristic subtracts a small
				// overlap from the sum, but never below the larger side (matches the
				// invariant that a full outer join returns every row from both inputs).
				return Math.max(
					leftRows,
					rightRows,
					leftRows + rightRows - Math.floor(leftRows * rightRows * 0.1),
				);
			case 'cross':
				// Cross join: cartesian product
				return leftRows * rightRows;
			default:
				return Math.max(leftRows, rightRows);
		}
	}

	/**
	 * Estimate rows for aggregation
	 */
	estimateAggregate(sourceRows: number, groupByCount: number): number {
		if (groupByCount === 0) {
			return 1; // Single aggregate row
		}
		// Assume reasonable grouping factor
		const groupingFactor = Math.min(0.8, Math.max(0.1, groupByCount * 0.2));
		return Math.max(1, Math.floor(sourceRows * groupingFactor));
	}

	/**
	 * Estimate rows for distinct operation
	 */
	estimateDistinct(sourceRows: number): number {
		// Assume moderate duplication - 70% unique rows
		return Math.max(1, Math.floor(sourceRows * 0.7));
	}

	/**
	 * Estimate rows for limit operation
	 */
	estimateLimit(sourceRows: number, limit: number, offset: number = 0): number {
		return Math.min(sourceRows, Math.max(0, limit - offset));
	}

	/**
	 * Get default row estimate when no information is available
	 */
	getDefaultEstimate(): number {
		return this.tuning.defaultRowEstimate;
	}
}

/**
 * Helper to safely get row estimate from a relational node
 */
export function getRowEstimate(node: RelationalPlanNode, tuning: OptimizerTuning): number {
	return node.estimatedRows ?? tuning.defaultRowEstimate;
}

/**
 * Helper to set row estimate on a node if not already set
 */
export function ensureRowEstimate(node: RelationalPlanNode, estimate: number): void {
	if (node.estimatedRows === undefined) {
		// Use Object.defineProperty to set a non-enumerable property
		// This maintains the immutability principle while adding metadata
		Object.defineProperty(node, 'estimatedRows', {
			value: estimate,
			writable: false,
			enumerable: true,
			configurable: false
		});
	}
}
