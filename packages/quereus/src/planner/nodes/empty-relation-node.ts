import { PlanNodeType } from './plan-node-type.js';
import {
	PlanNode,
	type ZeroAryRelationalNode,
	type Attribute,
	type PhysicalProperties,
} from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Schema-polymorphic empty relation: produces zero rows of the given
 * attribute schema. Used by const-folding rules that prove a subtree is
 * empty (e.g. `Filter(L, false)`, `InnerJoin(Empty, R)`). Distinct from
 * `EmptyResultNode`, which is tied to a `TableReferenceNode` and represents
 * an empty *table access*; this node is detached from any specific source.
 */
export class EmptyRelationNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.EmptyRelation;

	constructor(
		scope: Scope,
		public readonly attributes: readonly Attribute[],
		public readonly relationType: RelationType,
		estimatedCostOverride?: number,
	) {
		super(scope, estimatedCostOverride ?? 0.001);
	}

	getType(): RelationType {
		return this.relationType;
	}

	getAttributes(): readonly Attribute[] {
		return this.attributes;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`EmptyRelationNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this;
	}

	get estimatedRows(): number {
		return 0;
	}

	override computePhysical(): Partial<PhysicalProperties> {
		// Zero-row relations trivially satisfy any FD/EC/binding. We deliberately
		// avoid fabricating a synthetic `∅ → all_cols` here — downstream rules
		// would otherwise mistake this for a single-value source.
		return {
			estimatedRows: 0,
			ordering: undefined,
		};
	}

	override toString(): string {
		return `EMPTY RELATION (${this.attributes.length} cols)`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			numColumns: this.attributes.length,
			columnNames: this.attributes.map(a => a.name),
		};
	}
}
