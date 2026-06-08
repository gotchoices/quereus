import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import type { PlanningContext } from '../planning-context.js';
import { resolveTableSchema, resolveVtabModule, isCommittedSchemaRef } from './schema-resolution.js';

/**
 * Plans a table reference operation based on a FROM clause item.
 * Creates a TableReferenceNode and wraps it in a RetrieveNode to establish
 * the boundary between virtual table module execution and Quereus execution.
 *
 * @param fromClause The AST node representing a table in the FROM clause.
 * @param context The planning context to resolve table definitions.
 * @returns A RetrieveNode wrapping the TableReferenceNode for the specified table.
 * @throws {QuereusError} If the table is not found, the reference is ambiguous, or fromClause is not a simple table.
 */
export function buildTableReference(fromClause: AST.FromClause, context: PlanningContext): RetrieveNode {
	if (fromClause.type !== 'table') {
		throw new QuereusError('buildTableReference currently only supports simple table references.', StatusCode.INTERNAL);
	}

	// Detect committed pseudo-schema before resolving
	const readCommitted = isCommittedSchemaRef(fromClause.table.schema);

	// Resolve table schema at build time (committed schema is intercepted in resolveTableSchema)
	const tableSchema = resolveTableSchema(context, fromClause.table.name, fromClause.table.schema);

	// Resolve vtab module at build time
	const vtabModuleInfo = resolveVtabModule(context, tableSchema.vtabModuleName);

	const tableRef = new TableReferenceNode(
		context.scope,
		tableSchema,
		vtabModuleInfo.module,
		vtabModuleInfo.auxData,
		undefined,
		readCommitted,
		context.schemaManager,
	);

	// Wrap in RetrieveNode to establish vtab/Quereus boundary
	return new RetrieveNode(context.scope, tableRef, tableRef);
}

