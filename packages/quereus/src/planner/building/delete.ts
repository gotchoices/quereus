import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { DeleteNode } from '../nodes/delete-node.js';
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
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import { buildConstraintChecks } from './constraint-builder.js';
import { buildParentSideFKChecks } from './foreign-key-builder.js';
import { validateReturningQualifiers } from '../validation/returning-qualifier-validator.js';
import { isCommittedSchemaRef } from './schema-resolution.js';

export function buildDeleteStmt(
  ctx: PlanningContext,
  stmt: AST.DeleteStmt,
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

  // Plan the source of rows to delete. This is typically the table itself, potentially filtered.
  let sourceNode: RelationalPlanNode = tableRetrieve; // Use the RetrieveNode as source

  // Create a new scope with the table columns registered for column resolution
  const tableScope = new RegisteredScope(ctx.scope);
  const sourceAttributes = sourceNode.getAttributes();
  sourceNode.getType().columns.forEach((c, i) => {
    const attr = sourceAttributes[i];
    tableScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });

  // Create a new planning context with the updated scope for WHERE clause resolution
  const deleteCtx = { ...contextWithSchemaPath, scope: tableScope };

  if (stmt.where) {
    const filterExpression = buildExpression(deleteCtx, stmt.where);
    sourceNode = new FilterNode(deleteCtx.scope, sourceNode, filterExpression);
  }

  // Create OLD/NEW attributes for DELETE (OLD = actual values being deleted, NEW = all NULL)
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
      nullable: true, // NEW values are always NULL for DELETE
      isReadOnly: false
    },
    sourceRelation: `NEW.${tableReference.tableSchema.name}`
  }));

  const { oldRowDescriptor, newRowDescriptor, flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

  // Build context descriptor if we have context attributes
  const contextDescriptor: RowDescriptor = contextAttributes.length > 0 ? [] : undefined as any;
  if (contextDescriptor) {
    contextAttributes.forEach((attr, index) => {
      contextDescriptor[attr.id] = index;
    });
  }

  // Build constraint checks at plan time
  const constraintChecks = buildConstraintChecks(
    deleteCtx,
    tableReference.tableSchema,
    RowOpFlag.DELETE,
    oldAttributes,
    newAttributes,
    flatRowDescriptor,
    contextAttributes
  );

  // Build parent-side FK constraint checks if foreign_keys pragma is enabled
  if (ctx.db.options.getBooleanOption('foreign_keys')) {
    const parentFKChecks = buildParentSideFKChecks(
      ctx, tableReference.tableSchema, RowOpFlag.DELETE,
      oldAttributes, newAttributes, contextAttributes
    );
    constraintChecks.push(...parentFKChecks);
  }

  // Always inject ConstraintCheckNode for DELETE operations
  const constraintCheckNode = new ConstraintCheckNode(
    deleteCtx.scope,
    sourceNode,
    tableReference,
    RowOpFlag.DELETE,
    oldRowDescriptor,
    newRowDescriptor,
    flatRowDescriptor,
    constraintChecks,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  const deleteNode = new DeleteNode(
    deleteCtx.scope,
    tableReference,
    constraintCheckNode,
    oldRowDescriptor,
    flatRowDescriptor,
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  // Add DML executor node to perform the actual database delete operations
  const dmlExecutorNode = new DmlExecutorNode(
    deleteCtx.scope,
    deleteNode,
    tableReference,
    'delete',
    undefined, // onConflict not used for DELETE
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor
  );

  const resultNode: RelationalPlanNode = dmlExecutorNode;

  if (stmt.returning && stmt.returning.length > 0) {
    // Create returning scope with OLD/NEW attribute access
    const returningScope = new RegisteredScope(deleteCtx.scope);

    // Register OLD.* symbols (actual values being deleted)
    oldAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];
      returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );
    });

    // Register NEW.* symbols (always NULL for DELETE) and unqualified column names (default to OLD for DELETE)
    newAttributes.forEach((attr, columnIndex) => {
      const tableColumn = tableReference.tableSchema.columns[columnIndex];

      // NEW.column (always NULL for DELETE)
      returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
      );

      // Unqualified column (defaults to OLD for DELETE)
      const oldAttr = oldAttributes[columnIndex];
      returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );

      // Table-qualified form (table.column -> OLD for DELETE)
      const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
      returningScope.registerSymbol(tblQualified, (exp, s) =>
        new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldAttr.type, oldAttr.id, columnIndex)
      );
    });

    // Build RETURNING projections in the OLD/NEW context
    const returningProjections = stmt.returning.map(rc => {
      // TODO: Support RETURNING *
      if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

      // Validate qualifier usage on the AST before column resolution so the
      // NEW-in-DELETE guard fires before any "column not found" error.
      validateReturningQualifiers(rc.expr, 'DELETE');

      // Infer alias from column name if not explicitly provided
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        // For qualified column references like OLD.id, normalize to lowercase
        alias = rc.expr.table
					? `${rc.expr.table.toLowerCase()}.${rc.expr.name.toLowerCase()}`
					: rc.expr.name.toLowerCase();
      }

      return {
        node: buildExpression({ ...deleteCtx, scope: returningScope }, rc.expr) as ScalarPlanNode,
        alias: alias
      };
    });

    return new ReturningNode(deleteCtx.scope, dmlExecutorNode, returningProjections);
  }

	return new SinkNode(deleteCtx.scope, resultNode, 'delete');
}
