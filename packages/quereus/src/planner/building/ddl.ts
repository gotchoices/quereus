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
 * Validate the four reserved-tag surfaces of a direct CREATE TABLE — table-level
 * `WITH TAGS`, each column's tags, each table-level (named or unnamed) constraint's
 * tags, and each inline column constraint's tags — at their matching physical sites,
 * mirroring the declarative differ (`schema-differ.ts`). Diagnostics accumulate
 * table → columns → table-constraints → column-constraints and raise once via the
 * shared policy. Inline column-constraint tags (`ColumnDef.constraints[].tags`) ARE
 * validated here at the physical-constraint site (kept symmetric with the differ):
 * the parser lifts a trailing `WITH TAGS` onto an inline constraint only when it is
 * *named*, so an unnamed inline constraint defers its tags to the column (where
 * `cc.tags` is undefined and validateReservedTags is a no-op) — hence no `cc.name`
 * guard, and the iteration covers every constraint kind, not just check/unique/fk.
 */
function raiseCreateTableTagDiagnostics(stmt: AST.CreateTableStmt): void {
	const diagnostics = [
		...validateReservedTags(stmt.tags, 'physical-table'),
		...stmt.columns.flatMap(c => validateReservedTags(c.tags, 'physical-column')),
		...(stmt.constraints ?? []).flatMap(c => validateReservedTags(c.tags, 'physical-constraint')),
		...stmt.columns.flatMap(c => (c.constraints ?? []).flatMap(cc => validateReservedTags(cc.tags, 'physical-constraint'))),
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
