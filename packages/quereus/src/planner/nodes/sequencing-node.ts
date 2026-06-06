import { PlanNodeType } from './plan-node-type.js';
import { isRelationalNode, PlanNode, type Attribute, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';

/**
 * Represents a sequencing operation that adds a row number column to convert bags to sets.
 * This ensures uniqueness for operations that require set semantics.
 * The added column is typically projected away after use and not visible to the user.
 */
export class SequencingNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Sequencing;

	private outputTypeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly sequenceColumnName: string = '__row_seq',
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const sourceType = this.source.getType();

			// Add a sequence column to make this a set
			const sequenceColumn = {
				name: this.sequenceColumnName,
				type: {
					typeClass: 'scalar' as const,
					logicalType: INTEGER_TYPE,
					nullable: false,
					isReadOnly: true
				},
				generated: true
			};

			// Create a unique key based on all columns including the sequence
			// This guarantees the result is a set
			const allColumnsKey = sourceType.columns.map((_, index) => ({ index }))
				.concat([{ index: sourceType.columns.length }]); // Include sequence column

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: true, // This operation guarantees set semantics
				columns: [...sourceType.columns, sequenceColumn],
				keys: [allColumnsKey], // All columns including sequence form a unique key
				rowConstraints: sourceType.rowConstraints,
			} satisfies RelationType;
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): readonly Attribute[] {
		// Sequencing preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`SequencingNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			throw new Error('SequencingNode: child must be a RelationalPlanNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance preserving attributes (sequencing preserves source attributes)
		return new SequencingNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.sequenceColumnName
		);
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Sequencing doesn't change row count
	}

	override toString(): string {
		return `SEQUENCE ADD ${this.sequenceColumnName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			sequenceColumn: this.sequenceColumnName,
			purpose: 'Convert bag to set by adding unique row sequence'
		};
	}
}
