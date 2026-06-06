import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CreateTableNode } from '../nodes/create-table-node.js';
import { CreateIndexNode } from '../nodes/create-index-node.js';
import { validateReservedTags, type TagDiagnostic } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

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
 * Validate the three reserved-tag surfaces of a direct CREATE TABLE — table-level
 * `WITH TAGS`, each column's tags, and each table-level (named or unnamed)
 * constraint's tags — at their matching physical sites, mirroring the declarative
 * differ (`schema-differ.ts`). Diagnostics accumulate table → columns → constraints
 * and raise once via the shared policy. Inline *named* column-constraint tags
 * (`ColumnDef.constraints[].tags`) are intentionally excluded to stay symmetric with
 * the differ (see the ticket's Scope decisions).
 */
function raiseCreateTableTagDiagnostics(stmt: AST.CreateTableStmt): void {
	const diagnostics = [
		...validateReservedTags(stmt.tags, 'physical-table'),
		...stmt.columns.flatMap(c => validateReservedTags(c.tags, 'physical-column')),
		...(stmt.constraints ?? []).flatMap(c => validateReservedTags(c.tags, 'physical-constraint')),
	];
	raiseStmtTagDiagnostics(diagnostics, stmt);
}

/**
 * Raise the first error diagnostic via the shared reserved-tag policy, threading the
 * statement's source location for a sited error. Warnings (e.g. an empty ack
 * rationale) never block — they hit a no-op sink, matching the ALTER arm.
 */
function raiseStmtTagDiagnostics(diagnostics: TagDiagnostic[], stmt: AST.AstNode): void {
	raiseReservedTagDiagnostics(diagnostics, {
		loc: stmt.loc ? { line: stmt.loc.start.line, column: stmt.loc.start.column } : undefined,
		log: () => { /* warnings (e.g. empty ack rationale) never block */ },
	});
}
