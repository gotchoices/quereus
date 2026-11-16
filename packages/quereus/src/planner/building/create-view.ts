import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateViewNode } from '../nodes/create-view-node.js';
import { createViewToString } from '../../emit/ast-stringify.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { storedBodyContext } from '../stored-body-context.js';

/**
 * Plan the view body for arity validation. SELECT and VALUES bodies build
 * directly. DML bodies (INSERT/UPDATE/DELETE with RETURNING) are rejected
 * permanently — a view body re-evaluates on every reference, so a DML body
 * would re-drive writes on every read, which is incoherent with view
 * semantics. Mutations must be expressed in the query that *uses* the view.
 *
 * `homeSchemaName` — the schema the view/maintained table lands in. When given,
 * the body plans under that schema's home path ({@link Database._homeSchemaPath})
 * so unqualified names in the body resolve next to the object that owns them,
 * not against the creating statement's search path.
 */
export function planViewBody(ctx: PlanningContext, viewName: string, body: AST.QueryExpr, homeSchemaName?: string): RelationalPlanNode {
	if (homeSchemaName) {
		ctx = storedBodyContext(ctx, homeSchemaName);
	}
	switch (body.type) {
		case 'select': {
			const planned = buildSelectStmt(ctx, body);
			if (!isRelationalNode(planned)) {
				throw new QuereusError(
					`CREATE VIEW '${viewName}' body did not produce a relational result`,
					StatusCode.INTERNAL,
				);
			}
			return planned;
		}
		case 'values':
			return buildValuesStmt(ctx, body);
		case 'insert':
		case 'update':
		case 'delete':
			throw new QuereusError(
				`${body.type.toUpperCase()} cannot be used as a view body — a view re-evaluates on every reference, which would re-drive the write. Move the mutation into the statement that references the view.`,
				StatusCode.ERROR,
				undefined,
				body.loc?.start.line,
				body.loc?.start.column,
			);
	}
}

/**
 * Plans the body (read-only, so star-expansion and CTEs are resolved) to reject a DML body
 * at plan time and to check an explicit column list's arity against the body's projection.
 */
function validateViewBody(ctx: PlanningContext, viewName: string, stmt: AST.CreateViewStmt, schemaName: string): void {
	const planned = planViewBody(ctx, viewName, stmt.select, schemaName);
	if (!stmt.columns || stmt.columns.length === 0) return;
	const bodyArity = planned.getAttributes().length;
	if (stmt.columns.length !== bodyArity) {
		throw new QuereusError(
			`View '${viewName}' has ${stmt.columns.length} declared columns but body produces ${bodyArity}`,
			StatusCode.ERROR
		);
	}
}

/**
 * Builds a plan node for CREATE VIEW statements.
 */
export function buildCreateViewStmt(ctx: PlanningContext, stmt: AST.CreateViewStmt): CreateViewNode {
	// Canonical schemaName (see SchemaManager.canonicalSchemaName) — it becomes
	// the stored ViewSchema.schemaName in the create emitter. Unqualified names
	// land in the current schema, matching the other DDL builders.
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.view.schema ? sm.canonicalSchemaName(stmt.view.schema) : sm.getCurrentSchemaName();
	const viewName = stmt.view.name;

	// An unwind recreates a view the pre-apply catalog held, so its body is not planned: the
	// view goes back exactly as it was, even when what it reads is gone or not yet restored
	// (docs/schema-undo-plan.md § Guards during an unwind).
	if (!ctx.db._isSchemaUnwinding()) {
		validateViewBody(ctx, viewName, stmt, schemaName);
	}

	// The original SQL text is needed for the view definition
	// Reconstruct it from the AST using the proper stringifier
	const sql = createViewToString(stmt);

	return new CreateViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifNotExists,
		stmt.columns,
		stmt.select,
		sql,
		stmt.tags ? Object.freeze({ ...stmt.tags }) : undefined
	);
}


