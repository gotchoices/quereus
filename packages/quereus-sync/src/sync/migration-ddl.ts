/**
 * Reading one replicated migration's DDL with the engine's own parser.
 *
 * Shared by the store adapter (its idempotency decision and its apply-phase
 * classifier) and by the two sites that spot an ALTER PRIMARY KEY — the change
 * applicator's replicated path and the local commit capture — whose table
 * bookkeeping must then be re-filed (`rekey-on-pk-change.ts`). One parse, so every
 * reader reads one migration the same way.
 */

import { Parser } from '@quereus/quereus';
import { toError } from './sync-context.js';

/** The engine's parsed statement, as `Parser.parse` returns it. */
export type ParsedStatement = ReturnType<Parser['parse']>;

/**
 * Parse one migration's DDL, returning either the statement or the parse failure —
 * never throwing, and never deciding what a failure means: each caller does that for
 * itself (`decideAlterTable` logs it and executes the text as-is;
 * `validatesExistingRows` treats an unparseable migration as non-validating;
 * {@link isAlterPrimaryKeyDDL} treats it as not a key change).
 */
export function parseMigrationDDL(ddl: string): { stmt?: ParsedStatement; parseError?: Error } {
	try {
		return { stmt: new Parser().parse(ddl) };
	} catch (e) {
		return { parseError: toError(e) };
	}
}

/** Whether `ddl` is an `alter table … alter primary key (…)` statement. */
export function isAlterPrimaryKeyDDL(ddl: string | undefined): boolean {
	if (!ddl?.trim()) return false;
	const { stmt } = parseMigrationDDL(ddl);
	return stmt?.type === 'alterTable' && stmt.action.type === 'alterPrimaryKey';
}
