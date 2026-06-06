import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { CacheCapable } from '../framework/characteristics.js';

export type CacheStrategy = 'memory' | 'spill'; // Future: spill-to-disk

/**
 * CacheNode provides smart caching for any relational input.
 *
 * This node materializes its input on first iteration and serves
 * subsequent iterations from the cached result. It implements
 * smart threshold-based policies to avoid excessive memory usage.
 */
export class CacheNode extends PlanNode implements UnaryRelationalNode, CacheCapable {
	readonly nodeType = PlanNodeType.Cache;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly strategy: CacheStrategy = 'memory',
		public readonly threshold: number = 10000,  // Rows before switching to pass-through
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);
	}

	// Cache preserves source attributes exactly
	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getType(): RelationType {
		const sourceType = this.source.getType();
		// Cache preserves all properties of the source relation
		return {
			...sourceType,
			// Note: Caching doesn't change the logical properties
			// but may affect physical properties like ordering
		};
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CacheNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('CacheNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance preserving attributes (cache preserves source attributes exactly)
		return new CacheNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.strategy,
			this.threshold
		);
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	getCacheStrategy(): string {
		return this.strategy;
	}

	isCached(): boolean {
		return true;
	}

	override toString(): string {
		return `CACHE (${this.strategy}, threshold=${this.threshold})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			strategy: this.strategy,
			threshold: this.threshold,
			sourceNodeType: this.source.nodeType
		};
	}
}
