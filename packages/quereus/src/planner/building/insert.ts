import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt } from './select.js';
import { buildWithClause } from './with.js';
import { ValuesNode } from '../nodes/values-node.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import { buildExpression } from './expression.js';
import { checkColumnsAssignable, columnSchemaToDef } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode, TableReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag, type TableSchema } from '../../schema/table.js';
import { ReturningNode } from '../nodes/returning-node.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { DmlExecutorNode, type UpsertClausePlan } from '../nodes/dml-executor-node.js';
import { buildConstraintChecks } from './constraint-builder.js';
import { buildChildSideFKChecks } from './foreign-key-builder.js';
import { validateDeterministicDefault, validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { validateReturningQualifiers } from '../validation/returning-qualifier-validator.js';
import { isCommittedSchemaRef } from './schema-resolution.js';

/**
 * Creates a uniform row expansion projection that maps any relational source
 * to the target table's column structure, filling in defaults for omitted columns.
 * This ensures INSERT works orthogonally with any relational source.
 *
 * Generated columns are handled in two stages:
 * 1. First projection expands source to table structure with NULLs for generated columns
 * 2. Second projection computes generated column values using the expanded row
 */
function createRowExpansionProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	targetColumns: ColumnDef[],
	tableReference: TableReferenceNode,
	contextScope?: RegisteredScope
): RelationalPlanNode {
	const tableSchema = tableReference.tableSchema;
	const hasGeneratedColumns = tableSchema.columns.some(col => col.generated);

	// If we're inserting into all columns in table order with no generated columns, no expansion needed
	if (!hasGeneratedColumns && targetColumns.length === tableSchema.columns.length) {
		const allColumnsMatch = targetColumns.every((tc, i) =>
			tc.name.toLowerCase() === tableSchema.columns[i].name.toLowerCase()
		);
		if (allColumnsMatch) {
			return sourceNode; // Source already matches table structure
		}
	}

	// Create projection expressions for each table column
	const projections: Projection[] = [];
	const sourceAttributes = sourceNode.getAttributes();

	// If we have a context scope, we need to also register source columns in it
	// so that defaults can reference them (e.g., DEFAULT base_price + markup)
	if (contextScope) {
		targetColumns.forEach((targetCol, index) => {
			if (index < sourceAttributes.length) {
				const sourceAttr = sourceAttributes[index];
				const colNameLower = targetCol.name.toLowerCase();
				contextScope.registerSymbol(colNameLower, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, sourceAttr.type, sourceAttr.id, index)
				);
			}
		});
	}

	tableSchema.columns.forEach((tableColumn) => {
		// Find if this table column is in the target columns
		const targetColIndex = targetColumns.findIndex(tc =>
			tc.name.toLowerCase() === tableColumn.name.toLowerCase()
		);

		if (tableColumn.generated) {
			// Generated columns cannot be explicitly provided in INSERT
			if (targetColIndex >= 0) {
				throw new QuereusError(
					`Cannot INSERT into generated column '${tableColumn.name}'`,
					StatusCode.ERROR
				);
			}
			// Placeholder NULL — will be replaced in the second projection pass
			projections.push({
				node: buildExpression(ctx, { type: 'literal', value: null }) as ScalarPlanNode,
				alias: tableColumn.name
			});
		} else if (targetColIndex >= 0) {
			// This column is provided by the source - reference the source column
			if (targetColIndex < sourceAttributes.length) {
				const sourceAttr = sourceAttributes[targetColIndex];
				// Create a column reference to the source attribute
				const columnRef = new ColumnReferenceNode(
					ctx.scope,
					{ type: 'column', name: sourceAttr.name } satisfies AST.ColumnExpr,
					sourceAttr.type,
					sourceAttr.id,
					targetColIndex
				);
				projections.push({
					node: columnRef,
					alias: tableColumn.name
				});
			} else {
				throw new QuereusError(
					`Source has fewer columns than expected for INSERT target columns`,
					StatusCode.ERROR
				);
			}
		} else {
			// This column is omitted - use default value or NULL
			let defaultNode: ScalarPlanNode;
			// Use context scope for default evaluation if available
			const defaultCtx = contextScope ? { ...ctx, scope: contextScope } : ctx;
			if (tableColumn.defaultValue !== undefined) {
				// Use default value
				if (typeof tableColumn.defaultValue === 'object' && tableColumn.defaultValue !== null && 'type' in tableColumn.defaultValue) {
					// It's an AST.Expression - build it into a plan node with context scope
					defaultNode = buildExpression(defaultCtx, tableColumn.defaultValue as AST.Expression) as ScalarPlanNode;

					// Validate that the default expression is deterministic
					validateDeterministicDefault(defaultNode, tableColumn.name, tableSchema.name);
				} else {
					// Literal default value
					defaultNode = buildExpression(defaultCtx, { type: 'literal', value: tableColumn.defaultValue }) as ScalarPlanNode;
				}
			} else {
				// No default value - use NULL
				defaultNode = buildExpression(defaultCtx, { type: 'literal', value: null }) as ScalarPlanNode;
			}
			projections.push({
				node: defaultNode,
				alias: tableColumn.name
			});
		}
	});

	// Create first projection node that expands source to table structure
	let resultNode: RelationalPlanNode = new ProjectNode(ctx.scope, sourceNode, projections);

	// Second pass: compute generated column values using the expanded row
	if (hasGeneratedColumns) {
		resultNode = createGeneratedColumnProjection(ctx, resultNode, tableSchema);
	}

	return resultNode;
}

/**
 * Creates a projection that computes generated column values from an expanded row.
 * Non-generated columns pass through; generated columns are computed from their expressions.
 */
function createGeneratedColumnProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	tableSchema: TableSchema
): RelationalPlanNode {
	const sourceAttributes = sourceNode.getAttributes();
	const genProjections: Projection[] = [];

	// Create a scope where column names resolve to the source (expanded) row attributes
	const genScope = new RegisteredScope(ctx.scope);
	tableSchema.columns.forEach((col, colIndex) => {
		if (col.generated) return; // Generated columns can't be referenced by other generated columns
		const attr = sourceAttributes[colIndex];
		genScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, colIndex)
		);
	});

	const genCtx = { ...ctx, scope: genScope };

	tableSchema.columns.forEach((tableColumn, colIndex) => {
		if (tableColumn.generated && tableColumn.generatedExpr) {
			// Build the generated expression in the scope with access to non-generated columns
			const genNode = buildExpression(genCtx, tableColumn.generatedExpr) as ScalarPlanNode;
			validateDeterministicGenerated(genNode, tableColumn.name, tableSchema.name);

			genProjections.push({
				node: genNode,
				alias: tableColumn.name
			});
		} else {
			// Pass through non-generated column from source
			const attr = sourceAttributes[colIndex];
			genProjections.push({
				node: new ColumnReferenceNode(
					ctx.scope,
					{ type: 'column', name: attr.name } satisfies AST.ColumnExpr,
					attr.type,
					attr.id,
					colIndex
				),
				alias: tableColumn.name
			});
		}
	});

	return new ProjectNode(ctx.scope, sourceNode, genProjections);
}

/**
 * Builds UPSERT clause plans from AST UPSERT clauses.
 *
 * In UPSERT expressions:
 * - NEW.* refers to the proposed INSERT values
 * - Unqualified column names refer to the existing (conflicting) row values
 * - excluded.* is an alias for NEW.* (PostgreSQL compatibility)
 */
function buildUpsertClausePlans(
	ctx: PlanningContext,
	upsertClauses: AST.UpsertClause[],
	tableSchema: TableSchema,
	newAttributes: Attribute[],
): UpsertClausePlan[] {
	return upsertClauses.map(clause => {
		// Resolve conflict target columns to indices
		let conflictTargetIndices: number[] | undefined;
		if (clause.conflictTarget) {
			conflictTargetIndices = clause.conflictTarget.map(colName => {
				const colIndex = tableSchema.columns.findIndex(
					c => c.name.toLowerCase() === colName.toLowerCase()
				);
				if (colIndex === -1) {
					throw new QuereusError(
						`Column '${colName}' not found in table '${tableSchema.name}' for ON CONFLICT target`,
						StatusCode.ERROR
					);
				}
				return colIndex;
			});
		}

		if (clause.action === 'nothing') {
			return {
				conflictTargetIndices,
				action: 'nothing' as const,
			};
		}

		// Build UPDATE action
		// Create attributes for the existing row (conflict row)
		const existingAttributes = tableSchema.columns.map((col) => ({
			id: PlanNode.nextAttrId(),
			name: col.name,
			type: {
				typeClass: 'scalar' as const,
				logicalType: col.logicalType,
				nullable: !col.notNull,
				isReadOnly: true
			},
			sourceRelation: `existing.${tableSchema.name}`
		}));

		// Build row descriptors for NEW (proposed) and existing (conflict) rows
		const newRowDescriptor: RowDescriptor = [];
		newAttributes.forEach((attr, index) => {
			newRowDescriptor[attr.id] = index;
		});

		const existingRowDescriptor: RowDescriptor = [];
		existingAttributes.forEach((attr, index) => {
			existingRowDescriptor[attr.id] = index;
		});

		// Create scope for UPSERT SET expressions:
		// - NEW.* and excluded.* reference proposed insert values
		// - Unqualified names reference existing row values
		const upsertScope = new RegisteredScope(ctx.scope);

		// Register existing row columns (unqualified column names default to existing values)
		existingAttributes.forEach((attr, columnIndex) => {
			const col = tableSchema.columns[columnIndex];

			// Unqualified column name -> existing row value
			upsertScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Table-qualified form (table.column) -> existing row value
			const tblQualified = `${tableSchema.name.toLowerCase()}.${col.name.toLowerCase()}`;
			upsertScope.registerSymbol(tblQualified, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Register NEW.* references (proposed insert values)
		newAttributes.forEach((attr, columnIndex) => {
			const col = tableSchema.columns[columnIndex];

			// NEW.column -> proposed insert value
			upsertScope.registerSymbol(`new.${col.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// excluded.column -> proposed insert value (PostgreSQL compatibility)
			upsertScope.registerSymbol(`excluded.${col.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		const upsertCtx = { ...ctx, scope: upsertScope };

		// Build assignment expressions
		const assignments = new Map<number, ScalarPlanNode>();
		if (clause.assignments) {
			for (const assign of clause.assignments) {
				const colIndex = tableSchema.columns.findIndex(
					c => c.name.toLowerCase() === assign.column.toLowerCase()
				);
				if (colIndex === -1) {
					throw new QuereusError(
						`Column '${assign.column}' not found in table '${tableSchema.name}' for DO UPDATE SET`,
						StatusCode.ERROR
					);
				}
				const valueNode = buildExpression(upsertCtx, assign.value) as ScalarPlanNode;
				assignments.set(colIndex, valueNode);
			}
		}

		// Build WHERE condition if present
		let whereCondition: ScalarPlanNode | undefined;
		if (clause.where) {
			whereCondition = buildExpression(upsertCtx, clause.where) as ScalarPlanNode;
		}

		return {
			conflictTargetIndices,
			action: 'update' as const,
			assignments,
			whereCondition,
			newRowDescriptor,
			existingRowDescriptor,
		};
	});
}

export function buildInsertStmt(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
): PlanNode {
	// Apply schema path from statement if present
	const contextWithSchemaPath = stmt.schemaPath
		? { ...ctx, schemaPath: stmt.schemaPath }
		: ctx;

	// Block DML on committed pseudo-schema
	if (isCommittedSchemaRef(stmt.table.schema)) {
		throw new QuereusError(`Cannot modify committed-state table 'committed.${stmt.table.name}'`, StatusCode.ERROR);
	}

	const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, contextWithSchemaPath);
	const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

	// Process mutation context assignments if present
	const mutationContextValues = new Map<string, ScalarPlanNode>();
	const contextAttributes: Attribute[] = [];
	let contextScope: RegisteredScope | undefined;

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

		// Create a new scope for mutation context
		contextScope = new RegisteredScope(contextWithSchemaPath.scope);

		// Register mutation context variables in the scope (before evaluating expressions)
		contextAttributes.forEach((attr, index) => {
			const contextVar = tableReference.tableSchema.mutationContext![index];
			const varNameLower = contextVar.name.toLowerCase();

			// Register both unqualified and qualified names
			contextScope!.registerSymbol(varNameLower, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, index)
			);
			contextScope!.registerSymbol(`context.${varNameLower}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, index)
			);
		});

		// Build context value expressions using the context scope
		const contextWithScope = { ...contextWithSchemaPath, scope: contextScope };
		stmt.contextValues.forEach((assignment) => {
			const valueExpr = buildExpression(contextWithScope, assignment.value) as ScalarPlanNode;
			mutationContextValues.set(assignment.name, valueExpr);
		});
	}

	let targetColumns: ColumnDef[] = [];
	if (stmt.columns && stmt.columns.length > 0) {
		// Explicit columns specified — validate none are generated
		targetColumns = stmt.columns.map((colName) => {
			const colIndex = tableReference.tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (colIndex === undefined) {
				throw new QuereusError(
					`Column '${colName}' not found in table '${tableReference.tableSchema.name}'`,
					StatusCode.ERROR
				);
			}
			const colSchema = tableReference.tableSchema.columns[colIndex];
			if (colSchema.generated) {
				throw new QuereusError(
					`Cannot INSERT into generated column '${colName}'`,
					StatusCode.ERROR
				);
			}
			return columnSchemaToDef(colName, colSchema);
		});
	} else {
		// No explicit columns - default to all non-generated table columns in order
		targetColumns = tableReference.tableSchema.columns
			.filter(col => !col.generated)
			.map(col => columnSchemaToDef(col.name, col));
	}

	let sourceNode: RelationalPlanNode;

	if (stmt.values) {
		// VALUES clause - build the VALUES node
		const rows = stmt.values.map(rowExprs =>
			rowExprs.map(expr => buildExpression(contextWithSchemaPath, expr) as PlanNode as ScalarPlanNode)
		);

		// Check that there are the right number of columns in each row
		rows.forEach(row => {
			if (row.length !== targetColumns.length) {
				throw new QuereusError(`Column count mismatch in VALUES clause. Expected ${targetColumns.length} columns, got ${row.length}.`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
		});

		// Create VALUES node with target column names
		const targetColumnNames = targetColumns.map(col => col.name);
		sourceNode = new ValuesNode(contextWithSchemaPath.scope, rows, targetColumnNames);

	} else if (stmt.select) {
		// SELECT clause - build the SELECT statement
		let parentCtes: Map<string, CTEScopeNode> = new Map();
		if (stmt.withClause) {
			parentCtes = buildWithClause(contextWithSchemaPath, stmt.withClause);
		}
		const selectPlan = buildSelectStmt(contextWithSchemaPath, stmt.select, parentCtes);
		if (selectPlan.getType().typeClass !== 'relation') {
			throw new QuereusError('SELECT statement in INSERT did not produce a relational plan.', StatusCode.INTERNAL, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}
		sourceNode = selectPlan as RelationalPlanNode;
		checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);

	} else {
		throw new QuereusError('INSERT statement must have a VALUES clause or a SELECT query.', StatusCode.ERROR);
	}

	// ORTHOGONAL ROW EXPANSION: Apply uniform row expansion to map any source to table structure with defaults
	const expandedSourceNode = createRowExpansionProjection(contextWithSchemaPath, sourceNode, targetColumns, tableReference, contextScope);

	// Update targetColumns to reflect all table columns since we've expanded the source
	const finalTargetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));

	// Create OLD/NEW attributes for INSERT (OLD = all NULL, NEW = actual values)
	const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: {
			typeClass: 'scalar' as const,
			logicalType: col.logicalType,
			nullable: true, // OLD values are always NULL for INSERT
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
		ctx,
		tableReference.tableSchema,
		RowOpFlag.INSERT,
		oldAttributes,
		newAttributes,
		flatRowDescriptor,
		contextAttributes
	);

	// Build FK constraint checks if foreign_keys pragma is enabled
	if (ctx.db.options.getBooleanOption('foreign_keys')) {
		const fkChecks = buildChildSideFKChecks(
			ctx, tableReference.tableSchema, RowOpFlag.INSERT,
			oldAttributes, newAttributes, contextAttributes
		);
		constraintChecks.push(...fkChecks);
	}

	const insertNode = new InsertNode(
		ctx.scope,
		tableReference,
		finalTargetColumns,
		expandedSourceNode,
		flatRowDescriptor,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor
	);

	const constraintCheckNode = new ConstraintCheckNode(
		ctx.scope,
		insertNode,
		tableReference,
		RowOpFlag.INSERT,
		oldRowDescriptor,
		newRowDescriptor,
		flatRowDescriptor,
		constraintChecks,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor
	);

	// Build UPSERT clause plans if present
	let upsertClausePlans: UpsertClausePlan[] | undefined;
	if (stmt.upsertClauses && stmt.upsertClauses.length > 0) {
		upsertClausePlans = buildUpsertClausePlans(
			ctx,
			stmt.upsertClauses,
			tableReference.tableSchema,
			newAttributes
		);
	}

	// Add DML executor node to perform the actual database insert operations
	const dmlExecutorNode = new DmlExecutorNode(
		ctx.scope,
		constraintCheckNode,
		tableReference,
		'insert',
		stmt.onConflict,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor,
		upsertClausePlans
	);

	const resultNode: RelationalPlanNode = dmlExecutorNode;

	if (stmt.returning && stmt.returning.length > 0) {
		// Create returning scope with OLD/NEW attribute access
		const returningScope = new RegisteredScope(ctx.scope);

		// Register OLD.* symbols (always NULL for INSERT)
		oldAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];
			returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Register NEW.* symbols and unqualified column names (default to NEW)
		newAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];

			// NEW.column
			returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Unqualified column (defaults to NEW)
			returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Table-qualified form (table.column -> NEW)
			const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
			returningScope.registerSymbol(tblQualified, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Build RETURNING projections in the OLD/NEW context
		const returningProjections = stmt.returning.map(rc => {
			// TODO: Support RETURNING *
			if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);

			// Infer alias from column name if not explicitly provided
			let alias = rc.alias;
			if (!alias && rc.expr.type === 'column') {
				// For qualified column references like NEW.id, normalize to lowercase
				if (rc.expr.table) {
					alias = `${rc.expr.table.toLowerCase()}.${rc.expr.name.toLowerCase()}`;
				} else {
					alias = rc.expr.name.toLowerCase();
				}
			}

			// Validate qualifier usage on the AST before column resolution so the
			// OLD-in-INSERT guard fires before any "column not found" error.
			validateReturningQualifiers(rc.expr, 'INSERT');

			return {
				node: buildExpression({ ...ctx, scope: returningScope }, rc.expr) as ScalarPlanNode,
				alias: alias
			};
		});

		return new ReturningNode(ctx.scope, dmlExecutorNode, returningProjections);
	}

	return new SinkNode(ctx.scope, resultNode, 'insert');
}
