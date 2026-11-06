import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import type { RestorableRows } from '../../vtab/rollback-states.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode, tableSchemaAttributes } from '../nodes/reference.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { TableLiteralNode } from '../nodes/values-node.js';
import { rowSourceOverrideKey, type PlanningContext } from '../planning-context.js';
import { resolveTableSchema, resolveVtabModule, isCommittedSchemaRef } from './schema-resolution.js';

/** A FROM-clause table resolved against the catalog, before anything is planned over it. */
interface ResolvedFromTable {
	readonly tableSchema: TableSchema;
	/** `committed.<table>`: the module's committed rows, whatever the transaction holds. */
	readonly readCommitted: boolean;
}

function resolveFromTable(fromClause: AST.FromClause, context: PlanningContext): ResolvedFromTable {
	if (fromClause.type !== 'table') {
		throw new QuereusError('buildTableReference currently only supports simple table references.', StatusCode.INTERNAL);
	}
	// Detect committed pseudo-schema before resolving
	const readCommitted = isCommittedSchemaRef(fromClause.table.schema);
	// Resolve table schema at build time (committed schema is intercepted in resolveTableSchema)
	const tableSchema = resolveTableSchema(context, fromClause.table.name, fromClause.table.schema);
	return { tableSchema, readCommitted };
}

function retrieveFromModule(context: PlanningContext, { tableSchema, readCommitted }: ResolvedFromTable): RetrieveNode {
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
	return retrieveFromModule(context, resolveFromTable(fromClause, context));
}

/**
 * Plans a FROM-clause table as the relation a query READS: {@link buildTableReference}, unless the
 * statement supplies the table's rows itself (`PlanningContext.rowSourceOverrides`), in which case
 * the table plans as a scan of those rows. A write target and anything needing the
 * TableReferenceNode keeps calling {@link buildTableReference}.
 *
 * A `committed.<table>` read is never overridden: it asks for the module's committed rows, which
 * no rollback changes.
 */
export function buildTableSource(fromClause: AST.FromClause, context: PlanningContext): RelationalPlanNode {
	const resolved = resolveFromTable(fromClause, context);
	const rows = resolved.readCommitted
		? undefined
		: context.rowSourceOverrides?.get(rowSourceOverrideKey(resolved.tableSchema.schemaName, resolved.tableSchema.name));
	return rows ? scanSuppliedRows(context, resolved.tableSchema, rows) : retrieveFromModule(context, resolved);
}

/**
 * The table as a literal over `rows`, typed and attributed exactly as its TableReferenceNode would
 * be. No module serves these rows, so no access plan can claim a filter as handled, and none of
 * the facts a TableReferenceNode lifts from the table's declared CHECKs and assertions
 * (`TableReferenceNode.computePhysical`) is asserted over rows that were never judged against them.
 */
function scanSuppliedRows(context: PlanningContext, tableSchema: TableSchema, rows: RestorableRows): TableLiteralNode {
	return new TableLiteralNode(context.scope, rows, undefined, relationTypeFromTableSchema(tableSchema), tableSchemaAttributes(tableSchema));
}
