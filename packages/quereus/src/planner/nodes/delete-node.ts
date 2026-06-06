import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import { buildAttributesFromFlatDescriptor } from '../../util/row-descriptor.js';

/**
 * Represents a DELETE statement in the logical query plan.
 */
export class DeleteNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Delete;

  constructor(
    scope: Scope,
    public readonly table: TableReferenceNode,
    public readonly source: RelationalPlanNode, // Typically a FilterNode wrapping a TableReferenceNode
    public readonly oldRowDescriptor?: RowDescriptor, // For constraint checking
    public readonly flatRowDescriptor?: RowDescriptor,
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>, // Mutation context value expressions
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
  ) {
    super(scope);
  }

	getType(): RelationType {
		return this.source.getType();
	}

  getAttributes(): readonly Attribute[] {
    if (this.flatRowDescriptor && Object.keys(this.flatRowDescriptor).length > 0) {
      return buildAttributesFromFlatDescriptor(this.flatRowDescriptor);
    }
    // Fallback to source attributes for backward compatibility
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    // The source provides keys to be deleted, table is the target of deletions.
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    // Return the source relation as a child so optimizer can traverse it
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      throw new Error(`DeleteNode expects 1 child (source), got ${newChildren.length}`);
    }

    const newSource = newChildren[0] as RelationalPlanNode;
    if (!isRelationalNode(newSource)) {
      throw new Error('DeleteNode: child must be a RelationalPlanNode');
    }

    if (newSource === this.source) {
      return this;
    }

    return new DeleteNode(
      this.scope,
      this.table,
      newSource,
      this.oldRowDescriptor,
      this.flatRowDescriptor,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor
    );
  }

  computePhysical(): Partial<PhysicalProperties> {
    return {
      readonly: false,  // DELETE has side effects
      estimatedRows: this.source.estimatedRows
    };
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `DELETE FROM ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName
    };

    if (this.flatRowDescriptor) {
      props.hasFlatRowDescriptor = true;
    }

    return props;
  }
}
