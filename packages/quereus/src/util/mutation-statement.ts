import type { Row, SqlValue } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import { insertToString, updateToString, deleteToString } from '../emit/ast-stringify.js';

/**
 * Builds a deterministic INSERT statement for mutation logging.
 * Creates an AST and uses insertToString for consistency.
 */
export function buildInsertStatement(
	tableSchema: TableSchema,
	newRow: Row,
	contextRow?: Row
): string {
	// Build INSERT AST
	const stmt: AST.InsertStmt = {
		type: 'insert',
		table: { type: 'identifier', name: tableSchema.name },
		columns: tableSchema.columns.map(col => col.name),
		source: {
			type: 'values',
			values: [newRow.map(sqlValueToLiteralExpr)],
		} satisfies AST.ValuesStmt,
		contextValues: buildContextAssignments(tableSchema, contextRow)
	};

	return insertToString(stmt);
}

/**
 * Builds a deterministic UPDATE statement for mutation logging.
 */
export function buildUpdateStatement(
	tableSchema: TableSchema,
	newRow: Row,
	oldKeyValues: Row,
	contextRow?: Row
): string {
	const pkDef = tableSchema.primaryKeyDefinition;

	// Build UPDATE AST
	const stmt: AST.UpdateStmt = {
		type: 'update',
		table: { type: 'identifier', name: tableSchema.name },
		contextValues: buildContextAssignments(tableSchema, contextRow),
		assignments: tableSchema.columns.map((col, idx) => ({
			column: col.name,
			value: sqlValueToLiteralExpr(newRow[idx])
		})),
		where: buildWhereClause(pkDef, oldKeyValues, tableSchema)
	};

	return updateToString(stmt);
}

/**
 * Builds a deterministic DELETE statement for mutation logging.
 */
export function buildDeleteStatement(
	tableSchema: TableSchema,
	oldKeyValues: Row,
	contextRow?: Row
): string {
	const pkDef = tableSchema.primaryKeyDefinition;

	// Build DELETE AST
	const stmt: AST.DeleteStmt = {
		type: 'delete',
		table: { type: 'identifier', name: tableSchema.name },
		contextValues: buildContextAssignments(tableSchema, contextRow),
		where: buildWhereClause(pkDef, oldKeyValues, tableSchema)
	};

	return deleteToString(stmt);
}

/**
 * Converts a SqlValue to a LiteralExpr AST node.
 */
function sqlValueToLiteralExpr(value: SqlValue): AST.LiteralExpr {
	return {
		type: 'literal',
		value: value
	};
}

/**
 * Builds context assignments from context row values.
 */
function buildContextAssignments(
	tableSchema: TableSchema,
	contextRow?: Row
): AST.ContextAssignment[] | undefined {
	if (!contextRow || contextRow.length === 0 || !tableSchema.mutationContext) {
		return undefined;
	}

	return tableSchema.mutationContext.map((ctx, idx) => ({
		name: ctx.name,
		value: sqlValueToLiteralExpr(contextRow[idx])
	}));
}

/**
 * Builds a WHERE clause for primary key matching.
 * Returns an AND expression of pk_col = value for each PK column.
 */
function buildWhereClause(
	pkDef: TableSchema['primaryKeyDefinition'],
	keyValues: Row,
	tableSchema: TableSchema
): AST.Expression {
	const conditions: AST.Expression[] = pkDef.map((pkCol, idx) => ({
		type: 'binary' as const,
		operator: '=' as const,
		left: { type: 'column' as const, name: tableSchema.columns[pkCol.index].name },
		right: sqlValueToLiteralExpr(keyValues[idx])
	}));

	if (conditions.length === 0) {
		// Table has no primary key - return a tautology (WHERE 1)
		// Note: UPDATE/DELETE without row identification will affect all rows
		return { type: 'literal', value: 1 };
	}

	if (conditions.length === 1) {
		return conditions[0];
	}

	// Build nested AND expressions: (a AND b) AND c AND ...
	return conditions.reduce((acc, cond) => ({
		type: 'binary' as const,
		operator: 'and' as const,
		left: acc,
		right: cond
	}));
}

