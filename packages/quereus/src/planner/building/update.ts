import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { UpdateNode, type UpdateAssignment } from '../nodes/update-node.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { buildTableReference } from './table.js';
import { buildExpression } from './expression.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { buildConstraintChecks } from './constraint-builder.js';
import { buildChildSideFKChecks, buildParentSideFKChecks } from './foreign-key-builder.js';
import { isCommittedSchemaRef } from './schema-resolution.js';
import { validateDeterministicGenerated } from '../validation/determinism-validator.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
): PlanNode {
  // Block DML on committed pseudo-schema
  if (isCommittedSchemaRef(stmt.table.schema)) {
    throw new QuereusError(`Cannot modify committed-state table 'committed.${stmt.table.name}'`, StatusCode.ERROR);
  }

  // Apply schema path from statement if present
  const contextWithSchemaPath = stmt.schemaPath
    ? { ...ctx, schemaPath: stmt.schemaPath }
    : ctx;

  const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, contextWithSchemaPath);
	const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

  // Process mutation context assignments if present
  const mutationContextValues = new Map<string, ScalarPlanNode>();
  const contextAttributes: Attribute[] = [];

  if (stmt.contextValues && tableReference.tableSchema.mutationContext) {
    // Create context attributes
    tableReference.tableSchema.mutationContext.forEach((contextVar) => {
      contextAttributes.push({
        id: PlanNode.nextAttrId(),
        name: contextVar.name,
        type: {
          typeClass: 'scalar' as const,
          logicalType: contextVar.logicalType,
          nullable: !contextVar.notNull,
          isReadOnly: true
        },
        sourceRelation: `context.${tableReference.tableSchema.name}`
      });
    });

    // Build context value expressions (evaluated in the base scope, before table scope)
    stmt.contextValues.forEach((assignment) => {
      const valueExpr = buildExpression(contextWithSchemaPath, assignment.value) as ScalarPlanNode;
      mutationContextValues.set(assignment.name, valueExpr);
    });
  }

  // Plan the source of rows to update. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = buildTableReference({ type: 'table', table: stmt.table }, contextWithSchemaPath);

  // Create a new scope with the table columns registered for column resolution
  const tableScope = new RegisteredScope(ctx.scope);
  const sourceAttributes = sourceNode.getAttributes();
  sourceNode.getType().columns.forEach((c, i) => {
    const attr = sourceAttributes[i];
    tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });

  // Create a new planning context with the updated scope for WHERE clause resolution
  const updateCtx = { ...contextWithSchemaPath, scope: tableScope };

  // IMPORTANT: Build assignments FIRST to ensure parameter indices match SQL text order.
  // SQL: UPDATE t SET col = ?1 WHERE id = ?2
  // The SET clause parameters must be resolved before WHERE clause parameters.
  const assignments: UpdateAssignment[] = stmt.assignments.map(assign => {
    // Reject SET on generated columns
    const colIndex = tableReference.tableSchema.columnIndexMap.get(assign.column.toLowerCase());
    if (colIndex !== undefined && tableReference.tableSchema.columns[colIndex].generated) {
      throw new QuereusError(
        `Cannot UPDATE generated column '${assign.column}'`,
        StatusCode.ERROR
      );
    }
    const targetColumn: AST.ColumnExpr = { type: 'column', name: assign.column, table: stmt.table.name, schema: stmt.table.schema };
    return {
      targetColumn, // Keep as AST for now, emitter can resolve index
      value: buildExpression(updateCtx, assign.value),
    };
  });

  // Add implicit assignments for generated STORED columns (recompute after user assignments)
  for (const col of tableReference.tableSchema.columns) {
    if (col.generated && col.generatedExpr) {
      // Build generated expression in the table scope so it can reference columns
      const genNode = buildExpression(updateCtx, col.generatedExpr) as ScalarPlanNode;
      validateDeterministicGenerated(genNode, col.name, tableReference.tableSchema.name);
      const targetColumn: AST.ColumnExpr = { type: 'column', name: col.name, table: stmt.table.name, schema: stmt.table.schema };
      assignments.push({ targetColumn, value: genNode, isGenerated: true });
    }
  }

  // Now build the WHERE filter (parameters here get indices after SET clause parameters)
  if (stmt.where) {
    const filterExpression = buildExpression(updateCtx, stmt.where);
    sourceNode = new FilterNode(updateCtx.scope, sourceNode, filterExpression);
  }

  // Create OLD/NEW attributes for UPDATE (used for both RETURNING and non-RETURNING paths)
  const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: col.logicalType,
      nullable: !col.notNull,
      isReadOnly: false
    },
    sourceRelation: `OLD.${tableReference.tableSchema.name}`
  }));

  const newAttributes = tableReference.tableSchema.columns.map((col) => ({
    id: PlanNode.nextAttrId(),
    name: col.name,
    type: {
      typeClass: 'scalar' as const,
      logicalType: col.logicalType,
      nullable: !col.notNull,
      isReadOnly: false
    },
    sourceRelation: `NEW.${tableReference.tableSchema.name}`
  }));

  const { oldRowDescriptor, newRowDescriptor, flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

  // Build context descriptor if we have context attributes
  const contextDescriptor: RowDescriptor | undefined = contextAttributes.length > 0 ? [] : undefined;
  if (contextDescriptor) {
    contextAttributes.forEach((attr, index) => {
      contextDescriptor[attr.id] = index;
    });
  }

  // Build constraint checks at plan time
  const constraintChecks = buildConstraintChecks(
    updateCtx,
    tableReference.tableSchema,
    RowOpFlag.UPDATE,
    oldAttributes,
    newAttributes,
    flatRowDescriptor,
    contextAttributes
  );

  // Build FK constraint checks if foreign_keys pragma is enabled
  if (ctx.db.options.getBooleanOption('foreign_keys')) {
    // Child-side: check new FK values reference valid parent rows
    const childFKChecks = buildChildSideFKChecks(
      ctx, tableReference.tableSchema, RowOpFlag.UPDATE,
      oldAttributes, newAttributes, contextAttributes
    );
    // Parent-side: check no children reference old values being changed
    const parentFKChecks = buildParentSideFKChecks(
      ctx, tableReference.tableSchema, RowOpFlag.UPDATE,
      oldAttributes, newAttributes, contextAttributes
    );
    constraintChecks.push(...childFKChecks, ...parentFKChecks);
  }

  if (stmt.returning && stmt.returning.length > 0) {
    // For RETURNING, create coordinated attribute IDs like we do for INSERT
    const returningScope = new RegisteredScope(updateCtx.scope);

    // Create attribute ID index for NEW columns (used for RETURNING projection)
    const newColumnAttributeIds: number[] = [];
    newAttributes.forEach((attr, columnIndex) => {
      newColumnAttributeIds[columnIndex] = attr.id;
    });

    tableReference.tableSchema.columns.forEach((tableColumn, columnIndex) => {
      const newAttributeId = newAttributes[columnIndex].id;
      const oldAttributeId = oldAttributes[columnIndex].id;

      // Register the unqualified column name in the RETURNING scope (defaults to NEW values)
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) => {
        return new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            logicalType: tableColumn.logicalType,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          newAttributeId,
          columnIndex
        );
      });

      // Also register the table-qualified form (table.column) - defaults to NEW values
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            logicalType: tableColumn.logicalType,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          newAttributeId,
          columnIndex
        )
      );

      // Register NEW.column for UPDATE RETURNING (updated values)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            logicalType: tableColumn.logicalType,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          newAttributeId,
          columnIndex
        )
      );

      // Register OLD.column for UPDATE RETURNING (original values)
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(
          s,
          exp as AST.ColumnExpr,
          {
            typeClass: 'scalar',
            logicalType: tableColumn.logicalType,
            nullable: !tableColumn.notNull,
            isReadOnly: false
          },
          oldAttributeId,
          columnIndex
        )
      );
    });

    const returningProjections = stmt.returning.map(rc => {
      // TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

      // Infer alias from column name if not explicitly provided
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        // For qualified column references like NEW.id or OLD.id, normalize to lowercase
        if (rc.expr.table) {
          alias = `${rc.expr.table.toLowerCase()}.${rc.expr.name.toLowerCase()}`;
        } else {
          alias = rc.expr.name.toLowerCase();
        }
      }

      const columnIndex = tableReference.tableSchema.columns.findIndex(col => col.name.toLowerCase() === (rc.expr.type === 'column' ? rc.expr.name.toLowerCase() : ''));
      const projAttributeId = rc.expr.type === 'column' && columnIndex !== -1 ? newColumnAttributeIds[columnIndex] : undefined;

      return {
        node: buildExpression({ ...updateCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias,
        attributeId: projAttributeId
      };
    });

    // Create UpdateNode with both row descriptors for RETURNING coordination
    const updateNodeWithDescriptor = new UpdateNode(
      updateCtx.scope,
      tableReference,
      assignments,
      sourceNode,
      stmt.onConflict,
      oldRowDescriptor,
      newRowDescriptor,
      flatRowDescriptor,
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor
    );

    // For returning, we still need to execute the update before projecting
    // Always inject ConstraintCheckNode for UPDATE operations (provides required metadata)
    const constraintCheckNode = new ConstraintCheckNode(
      updateCtx.scope,
      updateNodeWithDescriptor,
      tableReference,
      RowOpFlag.UPDATE,
      oldRowDescriptor,
      newRowDescriptor,
      flatRowDescriptor,
      constraintChecks,
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor
    );

    const updateExecutorNode = new DmlExecutorNode(
      updateCtx.scope,
      constraintCheckNode,
      tableReference,
      'update',
      undefined, // onConflict not used for UPDATE
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor
    );

    // Return the RETURNING results from the executed update
    return new ReturningNode(updateCtx.scope, updateExecutorNode, returningProjections);
  }

  // Step 1: Create UpdateNode that produces updated rows (but doesn't execute them)
  // Create newRowDescriptor and oldRowDescriptor for constraint checking with NEW/OLD references
  const updateNode = new UpdateNode(
    updateCtx.scope,
    tableReference,
    assignments,
    sourceNode,
    stmt.onConflict,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  // Step 2: inject constraint checking AFTER update row generation
  const constraintCheckNode = new ConstraintCheckNode(
    updateCtx.scope,
    updateNode,
    tableReference,
    RowOpFlag.UPDATE,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    constraintChecks,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  const updateExecutorNode = new DmlExecutorNode(
    updateCtx.scope,
    constraintCheckNode,
    tableReference,
    'update',
    undefined, // onConflict not used for UPDATE
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  return new SinkNode(updateCtx.scope, updateExecutorNode, 'update');
}
