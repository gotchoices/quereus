import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import {
	validateReservedTags,
	getReservedTagByTemplate,
	type TagDiagnostic,
	type TagSite,
} from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';
import type { MutableViewLike } from './single-source.js';

const log = createLogger('mutation:tags');

/**
 * The view-mutation **override surface** — the read/validate/merge half of the
 * `quereus.update.*` tag namespace (`docs/view-updateability.md` § Tags: The
 * Override Surface). Shape/site validation itself lives in the typed registry
 * (`schema/reserved-tags.ts`); this module owns *where* tags are collected, how
 * an invalid one surfaces as a sited diagnostic, and how statement-level tags
 * override view-level tags for the duration of one statement. The *Effect* of
 * the one retained override (`default_for.<column>` — supply a value for an
 * omitted insert column) is realized by the propagation decomposers
 * (`single-source.ts` / `multi-source.ts`). Write *routing* is no longer a tag:
 * per-row writable presence/membership columns express it (the outer-join
 * existence column and the set-op membership columns), so the routing tags
 * (`target`/`exclude`/`delete_via`/`policy`) were removed.
 *
 * Tags arrive at two sites:
 * - **view DDL** (`ViewSchema.tags` / `MaterializedViewSchema.tags`) — validated
 *   at {@link TagSite} `'view-ddl'`.
 * - **DML statement** (`InsertStmt`/`UpdateStmt`/`DeleteStmt` `WITH TAGS (...)`,
 *   surfaced on `stmt.tags`) — validated at {@link TagSite} `'dml-stmt'`.
 *
 * Each set is validated at *its own* site, then merged with the statement
 * winning on a key collision.
 */
export type ReservedTagMap = Readonly<Record<string, SqlValue>>;

/** The one retained override-surface key family. */
const DEFAULT_FOR_TEMPLATE = 'quereus.update.default_for.<column>';

/** The DML carrying statement-level tags + a location for sited diagnostics. */
type TaggedStmt = Pick<AST.InsertStmt, 'tags' | 'loc'>;

/**
 * Validate the view-level and statement-level reserved tags at their respective
 * sites and merge them (statement over view) into the effective tag map for one
 * mutation. A `severity:'error'` diagnostic (unknown key, mis-sited key,
 * malformed value) is raised as a **sited** {@link QuereusError} carrying the
 * statement's line/column; `severity:'warning'` diagnostics (an empty
 * `quereus.lens.ack` rationale) are logged. Returns `undefined` when neither
 * site carries any tag (the common case — the propagation cost is unchanged).
 */
export function collectMutationTags(view: MutableViewLike, stmt: TaggedStmt): ReservedTagMap | undefined {
	const viewTags = view.tags;
	const stmtTags = stmt.tags;
	if ((!viewTags || Object.keys(viewTags).length === 0) && (!stmtTags || Object.keys(stmtTags).length === 0)) {
		return undefined;
	}

	raiseTagDiagnostics(validateReservedTags(viewTags as Record<string, SqlValue> | undefined, 'view-ddl'), view, stmt, 'view-ddl');
	raiseTagDiagnostics(validateReservedTags(stmtTags, 'dml-stmt'), view, stmt, 'dml-stmt');

	// Statement-level tags override view-level tags for this statement's duration.
	return { ...(viewTags ?? {}), ...(stmtTags ?? {}) };
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

// === typed readers for the consumers (no re-parsing the namespace) ===========

/**
 * Enumerated `quereus.update.default_for.<column>` instances — a (lowercased
 * column name → raw expression text) map. The registry has already proven the
 * value is TEXT; the consumer lowers the text to an AST expression. This is the
 * sole retained override reader (routing is now per-row presence/membership
 * columns, not a tag).
 */
export function readDefaultFor(tags: ReservedTagMap | undefined): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const inst of getReservedTagByTemplate(tags as Record<string, SqlValue> | undefined, DEFAULT_FOR_TEMPLATE)) {
		out.set(inst.segment.toLowerCase(), inst.value);
	}
	return out;
}
