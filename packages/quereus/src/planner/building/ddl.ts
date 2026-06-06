import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateTableNode } from '../nodes/create-table-node.js';
import { CreateIndexNode } from '../nodes/create-index-node.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { columnTagDiagnostics, raiseStmtTagDiagnostics } from './tag-diagnostics.js';

export function buildCreateTableStmt(
	context: PlanningContext,
	stmt: AST.CreateTableStmt,
): CreateTableNode {
	// Reject a misspelled / mis-sited reserved `quereus.*` tag at build time so the
	// direct CREATE path fails as loudly as ALTER ... SET TAGS and the declarative
	// differ — a typo can't be silently stored on the most common authoring path.
	raiseCreateTableTagDiagnostics(stmt);
	return new CreateTableNode(
		context.scope,
		stmt,
	);
}

export function buildCreateIndexStmt(
	context: PlanningContext,
	stmt: AST.CreateIndexStmt
): CreateIndexNode {
	// Index-level WITH TAGS validates at the physical-index site (mirrors the differ).
	raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'physical-index'), stmt);
	return new CreateIndexNode(
		context.scope,
		stmt
	);
}

/**
 * Validate the four reserved-tag surfaces of a direct CREATE TABLE — table-level
 * `WITH TAGS`, each column's tags, each inline column constraint's tags, and each
 * table-level (named or unnamed) constraint's tags — at their matching physical
 * sites, mirroring the declarative differ (`schema-differ.ts`). The per-column legs
 * (a column's own tags + its inline constraints' tags) come from the shared
 * {@link columnTagDiagnostics} helper, which the ALTER … ADD COLUMN path reuses so the
 * two authoring surfaces never drift. Diagnostics accumulate table → per-column →
 * table-constraints and raise once via the shared policy (first error wins).
 */
function raiseCreateTableTagDiagnostics(stmt: AST.CreateTableStmt): void {
	const diagnostics = [
		...validateReservedTags(stmt.tags, 'physical-table'),
		...stmt.columns.flatMap(columnTagDiagnostics),
		...(stmt.constraints ?? []).flatMap(c => validateReservedTags(c.tags, 'physical-constraint')),
	];
	raiseStmtTagDiagnostics(diagnostics, stmt);
}
