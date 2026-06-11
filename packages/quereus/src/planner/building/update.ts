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
import { AliasedScope } from '../scopes/aliased.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag, type RowConstraintSchema } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { buildConstraintChecks, buildNotNullDefaults } from './constraint-builder.js';
import { buildChildSideFKChecks, buildParentSideFKChecks } from './foreign-key-builder.js';
import { isCommittedSchemaRef } from './schema-resolution.js';
import { validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { buildViewMutation } from './view-mutation-builder.js';
import { maintainedTableViewLike } from '../../schema/derivation.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { raiseStmtTagDiagnostics } from './tag-diagnostics.js';

export function buildUpdateStmt(
  ctx: PlanningContext,
  stmt: AST.UpdateStmt,
  /**
   * Extra row-local CHECK constraints to enforce, already resolved in the target
   * table's column space — set only when the view-mutation substrate re-plans a
   * lens write onto its basis table (the logical `enforced-row-local` obligations
   * rewritten to basis terms; see `planner/mutation/lens-enforcement.ts`). Empty
   * for ordinary updates.
   */
  extraConstraints: ReadonlyArray<RowConstraintSchema> = [],
  /**
   * Whether this update is the basis-table spine of a write routed through a lens
   * view (the view-mutation builder sets it when the target view resolves to a lens
   * slot). Threaded onto the {@link DmlExecutorNode} so the runtime parent-side
   * **logical** FK machinery fires only for lens-routed writes — see that node's
   * `lensRouted` field. Default `false` for ordinary base-table updates.
   */
  lensRouted = false,
): PlanNode {
  // Statement-level WITH TAGS validates at the dml-stmt site on every authoring
  // path — base table, view/MV-mediated, nested DML (see buildInsertStmt).
  raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt);

  // Block DML on committed pseudo-schema
  if (isCommittedSchemaRef(stmt.table.schema)) {
    throw new QuereusError(`Cannot modify committed-state table 'committed.${stmt.table.name}'`, StatusCode.ERROR);
  }

  // Apply schema path from statement if present
  const contextWithSchemaPath = stmt.schemaPath
    ? { ...ctx, schemaPath: stmt.schemaPath }
    : ctx;

  // View- or materialized-view-mediated update: rewrite to target the underlying
  // base table and re-plan. An MV is a single-source projection-and-filter, so the
  // same rewrite routes write-through to its source `T`; the row-time maintenance
  // hook then syncs the backing. See docs/materialized-views.md § Write boundary.
  // Dispatch order is load-bearing: a maintained table (derivation-bearing)
  // must hit the view-mutation rewrite, never the direct table write.
  const updateMaintained = ctx.schemaManager.getMaintainedTable(stmt.table.schema ?? null, stmt.table.name);
  const updateView = ctx.schemaManager.getView(stmt.table.schema ?? null, stmt.table.name)
    ?? (updateMaintained ? maintainedTableViewLike(updateMaintained) : undefined);
  if (updateView) {
    // Route through the view-mutation substrate (single-source = one base op).
    return buildViewMutation(contextWithSchemaPath, updateView, { op: 'update', stmt });
  }

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

  // Create a new scope with the table columns registered for column resolution.
  // Wrap with AliasedScope so correlated subqueries inside SET / WHERE / RETURNING
  // can reference the outer DML target via qualified `table.column` form.
  const tableColumnScope = new RegisteredScope(ctx.scope);
  const sourceAttributes = sourceNode.getAttributes();
  sourceNode.getType().columns.forEach((c, i) => {
    const attr = sourceAttributes[i];
    tableColumnScope.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });
  const tableName = tableReference.tableSchema.name.toLowerCase();
  // The view-mutation single-source lowering may carry a synthesised collision-proof
  // correlation name on the target (`stmt.alias`), so a substituted subquery-descent
  // base term qualified with it binds the outer target row even when the user subquery
  // FROM names the same base table. Ordinary UPDATE never sets `stmt.alias`, so the
  // correlation name is the table name and the AliasedScope behaves identically.
  const correlationName = stmt.alias?.toLowerCase() ?? tableName;
  const tableScope = new AliasedScope(tableColumnScope, tableName, correlationName);

  // Create a new planning context with the updated scope for WHERE clause resolution
  const updateCtx = { ...contextWithSchemaPath, scope: tableScope };

  // IMPORTANT: Build assignments FIRST to ensure parameter indices match SQL text order.
  // SQL: UPDATE t SET col = ?1 WHERE id = ?2
  // The SET clause parameters must be resolved before WHERE clause parameters.
  // Authoritative backstop against assigning the same base column twice in one
  // UPDATE. This is the single place that catches all paths — a direct base
  // UPDATE (`set b=1, b=2`), the single-source lowered statement, and each
  // multi-source per-member lowered statement — since every lowered view write is
  // re-planned through here. Keyed on the user SET target name, so it runs before
  // the appended generated-column assignments (a generated column can't be SET, so
  // it never collides with a user target). The view spines add a friendlier,
  // view-aware diagnostic on top of this generic backstop.
  const seenTargets = new Set<string>();
  const assignments: UpdateAssignment[] = stmt.assignments.map(assign => {
    const targetKey = assign.column.toLowerCase();
    if (seenTargets.has(targetKey)) {
      throw new QuereusError(
        `duplicate assignment to column '${assign.column}' in UPDATE on '${tableReference.tableSchema.name}'`,
        StatusCode.ERROR
      );
    }
    seenTargets.add(targetKey);
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

  // Add implicit assignments for generated columns in topological order so
  // that a generated column referencing another generated column sees the
  // freshly-computed value when the runtime evaluates each in turn against
  // the in-place updated row.
  const genTopoOrder = tableReference.tableSchema.generatedColumnTopoOrder ?? [];
  for (const colIdx of genTopoOrder) {
    const col = tableReference.tableSchema.columns[colIdx];
    if (!col.generated || !col.generatedExpr) continue;
    const genNode = buildExpression(updateCtx, col.generatedExpr) as ScalarPlanNode;
    if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
      validateDeterministicGenerated(genNode, col.name, tableReference.tableSchema.name);
    }
    const targetColumn: AST.ColumnExpr = { type: 'column', name: col.name, table: stmt.table.name, schema: stmt.table.schema };
    assignments.push({ targetColumn, value: genNode, isGenerated: true });
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
    contextAttributes,
    extraConstraints
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

  // Pre-build DEFAULT evaluators for NOT NULL columns (used by REPLACE substitution).
  const notNullDefaults = buildNotNullDefaults(
    updateCtx, tableReference.tableSchema, newAttributes, contextAttributes
  );

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

      // Infer alias from column name if not explicitly provided.
      // Preserve the spelling the user wrote so quoted identifiers like
      // [Name] / "Name" round-trip to the result column name unchanged.
      let alias = rc.alias;
      if (!alias && rc.expr.type === 'column') {
        alias = rc.expr.table
          ? `${rc.expr.table}.${rc.expr.name}`
          : rc.expr.name;
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
      contextDescriptor,
      undefined, // onConflict — UPDATE has no statement-level OR clause; per-constraint defaults apply
      notNullDefaults.length > 0 ? notNullDefaults : undefined
    );

    const updateExecutorNode = new DmlExecutorNode(
      updateCtx.scope,
      constraintCheckNode,
      tableReference,
      'update',
      undefined, // onConflict — UPDATE has no statement-level OR clause
      mutationContextValues.size > 0 ? mutationContextValues : undefined,
      contextAttributes.length > 0 ? contextAttributes : undefined,
      contextDescriptor,
      undefined, // upsertClauses — UPDATE has none
      lensRouted
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
    contextDescriptor,
    undefined, // onConflict — UPDATE has no statement-level OR clause; per-constraint defaults apply
    notNullDefaults.length > 0 ? notNullDefaults : undefined
  );

  const updateExecutorNode = new DmlExecutorNode(
    updateCtx.scope,
    constraintCheckNode,
    tableReference,
    'update',
    undefined, // onConflict — UPDATE has no statement-level OR clause
    mutationContextValues.size > 0 ? mutationContextValues : undefined,
    contextAttributes.length > 0 ? contextAttributes : undefined,
    contextDescriptor,
    undefined, // upsertClauses — UPDATE has none
    lensRouted
  );

  return new SinkNode(updateCtx.scope, updateExecutorNode, 'update');
}
