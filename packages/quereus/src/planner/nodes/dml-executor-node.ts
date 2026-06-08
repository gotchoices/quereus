import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type PhysicalProperties, type ScalarPlanNode, type RowDescriptor, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { ConflictResolution } from '../../common/constants.js';
import { RowOp } from '../../common/types.js';

/**
 * Represents a planned UPSERT clause for INSERT operations.
 * This contains the pre-built plan nodes for ON CONFLICT DO UPDATE handling.
 */
export interface UpsertClausePlan {
	/** Conflict target column indices (matches PK if undefined) */
	conflictTargetIndices?: number[];
	/** Action: 'nothing' skips the row, 'update' performs column updates */
	action: 'nothing' | 'update';
	/**
	 * For 'update' action: column assignments.
	 * Key is column index, value is the expression node to evaluate.
	 * Expressions can reference:
	 * - NEW.* (proposed insert values) via newRowDescriptor
	 * - unqualified column names (existing row values) via existingRowDescriptor
	 */
	assignments?: Map<number, ScalarPlanNode>;
	/** For 'update' action: optional WHERE condition plan */
	whereCondition?: ScalarPlanNode;
	/** Row descriptor for NEW.* references (proposed insert values) */
	newRowDescriptor?: RowDescriptor;
	/** Row descriptor for existing row references (conflict row) */
	existingRowDescriptor?: RowDescriptor;
}

/**
 * Executes actual database insert/update/delete operations after constraint validation.
 * This node performs the actual vtab.update operations and yields the affected rows.
 * All data transformations (defaults, conversions, etc.) happen before this node.
 */
export class DmlExecutorNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.UpdateExecutor;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOp,
    public readonly onConflict?: ConflictResolution, // Used for INSERT operations (legacy OR clause)
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>, // Mutation context value expressions
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
    public readonly upsertClauses?: UpsertClausePlan[], // UPSERT clause plans for INSERT operations
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): readonly Attribute[] {
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    return [this.source];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 1) {
      throw new Error(`UpdateExecutorNode expects 1 child, got ${newChildren.length}`);
    }

    const [newSource] = newChildren;

    // Type check
    if (!isRelationalNode(newSource)) {
      throw new Error('UpdateExecutorNode: child must be a RelationalPlanNode');
    }

    // Return same instance if nothing changed
    if (newSource === this.source) {
      return this;
    }

    // Create new instance
    return new DmlExecutorNode(
      this.scope,
      newSource,
      this.table,
      this.operation,
      this.onConflict,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor,
      this.upsertClauses
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    return `EXECUTE ${this.operation} ${this.table.tableSchema.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      operation: this.operation,
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
    };

    if (this.onConflict) {
      props.onConflict = this.onConflict;
    }

    if (this.upsertClauses && this.upsertClauses.length > 0) {
      props.upsertClauses = this.upsertClauses.map(clause => ({
        action: clause.action,
        hasConflictTarget: !!clause.conflictTargetIndices,
        hasWhere: !!clause.whereCondition,
        assignmentCount: clause.assignments?.size ?? 0
      }));
    }

    return props;
  }

  computePhysical(): Partial<PhysicalProperties> {
    return {
      readonly: false, // DML executor has side effects
      idempotent: false, // DML operations are generally not idempotent
      // Non-deterministic via the side-effect axis: a write changes
      // database state, so the executor cannot be folded by determinism-
      // gated machinery (CHECK / DEFAULT / generated columns / assertions).
      deterministic: false,
    };
  }
}
