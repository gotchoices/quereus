import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import {
	validateReservedTags,
	type TagDiagnostic,
	type TagSite,
} from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';
import type { MutableViewLike } from './single-source.js';

const log = createLogger('mutation:tags');

/**
 * Reserved-tag **validation at the view-mutation boundary**. No reserved tag
 * carries view-mutation behavior anymore — write *routing* is per-row writable
 * presence/membership columns (the outer-join existence column and the set-op
 * membership columns), and omitted-insert *defaults* are the first-class
 * `insert defaults (col = expr, …)` view clause (which retired the last
 * `quereus.update.*` key, `default_for.<column>`). What remains here is the
 * guard: a typo'd or mis-sited `quereus.*` key on a view or a DML statement
 * must still fail loudly at mutation time. Shape/site validation itself lives
 * in the typed registry (`schema/reserved-tags.ts`); this module owns *where*
 * tags are collected and how an invalid one surfaces as a sited diagnostic.
 *
 * Tags arrive at two sites:
 * - **view DDL** (`ViewSchema.tags` / `MaterializedViewSchema.tags`) — validated
 *   at {@link TagSite} `'view-ddl'`.
 * - **DML statement** (`InsertStmt`/`UpdateStmt`/`DeleteStmt` `WITH TAGS (...)`,
 *   surfaced on `stmt.tags`) — validated at {@link TagSite} `'dml-stmt'`.
 *
 * Each set is validated at *its own* site.
 */

/** The DML carrying statement-level tags + a location for sited diagnostics. */
type TaggedStmt = Pick<AST.InsertStmt, 'tags' | 'loc'>;

/**
 * Validate the view-level and statement-level reserved tags at their respective
 * sites. A `severity:'error'` diagnostic (unknown key, mis-sited key, malformed
 * value) is raised as a **sited** {@link QuereusError} carrying the statement's
 * line/column; `severity:'warning'` diagnostics (an empty `quereus.lens.ack`
 * rationale) are logged. A no-tags mutation short-circuits (the common case —
 * the propagation cost is unchanged).
 */
export function validateMutationTags(view: MutableViewLike, stmt: TaggedStmt): void {
	const viewTags = view.tags;
	const stmtTags = stmt.tags;
	if ((!viewTags || Object.keys(viewTags).length === 0) && (!stmtTags || Object.keys(stmtTags).length === 0)) {
		return;
	}

	raiseTagDiagnostics(validateReservedTags(viewTags as Record<string, SqlValue> | undefined, 'view-ddl'), view, stmt, 'view-ddl');
	raiseTagDiagnostics(validateReservedTags(stmtTags, 'dml-stmt'), view, stmt, 'dml-stmt');
}

/**
 * Raise the first error diagnostic as a sited error; log any warnings. Threads
 * the statement location + a view-context prefix into the shared caller-policy
 * helper ({@link raiseReservedTagDiagnostics}).
 */
function raiseTagDiagnostics(diagnostics: TagDiagnostic[], view: MutableViewLike, stmt: TaggedStmt, site: TagSite): void {
	raiseReservedTagDiagnostics(diagnostics, {
		messagePrefix: site === 'view-ddl'
			? `view '${view.schemaName}.${view.name}' declares an invalid tag — `
			: '',
		loc: { line: stmt.loc?.start.line, column: stmt.loc?.start.column },
		log: (diag) => log('tag advisory (%s) on %s %s.%s: %s', diag.reason, site, view.schemaName, view.name, diag.message),
	});
}
