import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import {
	validateReservedTags,
	getReservedTag,
	getReservedTagByTemplate,
	type TagDiagnostic,
	type TagSite,
	type DeleteViaValue,
	type UpdatePolicyValue,
} from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';
import type { MutableViewLike } from './single-source.js';

const log = createLogger('mutation:tags');

/**
 * The view-mutation **override surface** — the read/validate/merge half of the
 * `quereus.update.*` tag mini-language (`docs/view-updateability.md` § Tags: The
 * Override Surface). Shape/site validation itself lives in the typed registry
 * (`schema/reserved-tags.ts`); this module owns *where* tags are collected, how
 * an invalid one surfaces as a sited diagnostic, and how statement-level tags
 * override view-level tags for the duration of one statement. The *Effect* of
 * each merged tag (narrowing the base set, supplying an insert default, picking
 * a deletion side, the strict/lenient policy) is realized by the propagation
 * decomposers (`single-source.ts` / `multi-source.ts`).
 *
 * Tags arrive at two sites:
 * - **view DDL** (`ViewSchema.tags` / `MaterializedViewSchema.tags`) — validated
 *   at {@link TagSite} `'view-ddl'`.
 * - **DML statement** (`InsertStmt`/`UpdateStmt`/`DeleteStmt` `WITH TAGS (...)`,
 *   surfaced on `stmt.tags`) — validated at {@link TagSite} `'dml-stmt'`.
 *
 * Each set is validated at *its own* site (a key legal on a view DDL — e.g.
 * `policy` — is illegal on a statement, and vice-versa), then merged with the
 * statement winning on a key collision.
 */
export type ReservedTagMap = Readonly<Record<string, SqlValue>>;

/** Reserved exact keys the override surface reads. */
const TARGET_KEY = 'quereus.update.target';
const EXCLUDE_KEY = 'quereus.update.exclude';
const DELETE_VIA_KEY = 'quereus.update.delete_via';
const POLICY_KEY = 'quereus.update.policy';
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

/** `quereus.update.policy`, defaulting to `'lenient'` when absent. */
export function readPolicy(tags: ReservedTagMap | undefined): UpdatePolicyValue {
	return (getReservedTag(tags as Record<string, SqlValue> | undefined, POLICY_KEY) as UpdatePolicyValue | undefined) ?? 'lenient';
}

/** `quereus.update.delete_via`, or undefined. */
export function readDeleteVia(tags: ReservedTagMap | undefined): DeleteViaValue | undefined {
	return getReservedTag(tags as Record<string, SqlValue> | undefined, DELETE_VIA_KEY) as DeleteViaValue | undefined;
}

/** Parsed, lowercased identifier list for `quereus.update.target` (or undefined). */
export function readTargetNames(tags: ReservedTagMap | undefined): readonly string[] | undefined {
	return readCsvIdentifiers(tags, TARGET_KEY);
}

/** Parsed, lowercased identifier list for `quereus.update.exclude` (or undefined). */
export function readExcludeNames(tags: ReservedTagMap | undefined): readonly string[] | undefined {
	return readCsvIdentifiers(tags, EXCLUDE_KEY);
}

/**
 * Enumerated `quereus.update.default_for.<column>` instances — a (lowercased
 * column name → raw expression text) map. The registry has already proven the
 * value is TEXT; the consumer lowers the text to an AST expression.
 */
export function readDefaultFor(tags: ReservedTagMap | undefined): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const inst of getReservedTagByTemplate(tags as Record<string, SqlValue> | undefined, DEFAULT_FOR_TEMPLATE)) {
		out.set(inst.segment.toLowerCase(), inst.value);
	}
	return out;
}

/** True when the override surface carries any base-set routing tag. */
export function hasRoutingTags(tags: ReservedTagMap | undefined): boolean {
	if (!tags) return false;
	return TARGET_KEY in tags || EXCLUDE_KEY in tags || DELETE_VIA_KEY in tags;
}

function readCsvIdentifiers(tags: ReservedTagMap | undefined, key: string): readonly string[] | undefined {
	const raw = getReservedTag(tags as Record<string, SqlValue> | undefined, key);
	if (typeof raw !== 'string') return undefined;
	return raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
}
