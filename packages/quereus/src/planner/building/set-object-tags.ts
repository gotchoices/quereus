import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import type { VoidNode } from '../nodes/plan-node.js';
import { SetObjectTagsNode, type SetObjectTagsKind } from '../nodes/set-object-tags-node.js';
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

/**
 * Shared builder for `ALTER VIEW / MATERIALIZED VIEW / INDEX … SET TAGS`. Each
 * validates any reserved `quereus.*` tags at the site that matches the object
 * kind (view / materialized view → `view-ddl`, index → `physical-index`) so a
 * typo fails loudly at plan-build time — the same registry the CREATE and
 * declarative paths route through. An unqualified name resolves to the current
 * default schema (matching the CREATE / DROP MATERIALIZED VIEW builders) so an
 * unqualified ALTER under a switched current schema targets the right object
 * rather than always looking in `main`.
 */
function buildSetObjectTags(
	ctx: PlanningContext,
	objectKind: SetObjectTagsKind,
	name: AST.IdentifierExpr,
	tags: Record<string, SqlValue>,
	site: TagSite,
): VoidNode {
	raiseReservedTagDiagnostics(
		validateReservedTags(tags, site),
		{ log: () => { /* warnings (e.g. empty ack rationale) never block */ } },
	);
	const schemaName = name.schema || ctx.schemaManager.getCurrentSchemaName();
	return new SetObjectTagsNode(ctx.scope, objectKind, schemaName, name.name, tags);
}

export function buildAlterViewStmt(ctx: PlanningContext, stmt: AST.AlterViewStmt): VoidNode {
	return buildSetObjectTags(ctx, 'view', stmt.name, stmt.action.tags, 'view-ddl');
}

export function buildAlterMaterializedViewStmt(ctx: PlanningContext, stmt: AST.AlterMaterializedViewStmt): VoidNode {
	return buildSetObjectTags(ctx, 'materializedView', stmt.name, stmt.action.tags, 'view-ddl');
}

export function buildAlterIndexStmt(ctx: PlanningContext, stmt: AST.AlterIndexStmt): VoidNode {
	return buildSetObjectTags(ctx, 'index', stmt.name, stmt.action.tags, 'physical-index');
}
