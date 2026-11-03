import type { Row } from '../common/types.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';

/**
 * A re-callable row stream for one state a rollback could restore. A module's own states are
 * synchronous walks over its trees; a wrapper's (`IssuerRowSources.savepoints`) are async.
 */
export type RestorableRows = () => Iterable<Row> | AsyncIterable<Row>;

/**
 * The refusal every row-validating DDL raises when a state a rollback could return the table to
 * — its committed rows, or the rows as they stood at an open savepoint — would violate the rule
 * the DDL declares. DDL survives a rollback on the bundled backends (the `non-transactional`
 * tier, docs/module-capabilities.md), the rows it was judged against do not, and the DDL
 * statement is the last point that can report the conflict.
 *
 * `BUSY`, the retryable posture of the memory backend's primary-key representability pass: the
 * data the transaction can SEE is valid, and `commit` followed by the same statement lands it.
 * Tests match `/commit the pending writes first/i`. `ddl` names the statement as the user wrote
 * it (`create unique index ix`, `alter column v set not null`), `tableName` the user's table —
 * a wrapper raising this for a staging table must substitute the user's name.
 */
export function rolledBackRowsWouldViolate(ddl: string, tableName: string, cause?: Error): QuereusError {
	return new QuereusError(
		`Cannot ${ddl} on table ${tableName}: rows this transaction has deleted or overwritten would violate it `
		+ `if the transaction rolled back. Commit the pending writes first, then retry.`,
		StatusCode.BUSY,
		cause,
	);
}

/** The one attribute an `alter column` statement changes, as both bundled backends spell it. */
export interface AlterColumnAttributes {
	readonly columnName: string;
	readonly setCollation?: string;
	readonly setNotNull?: boolean;
	readonly setDataType?: string;
	readonly setDefault?: unknown;
}

/** The `alter column` statement as the user wrote it, for {@link rolledBackRowsWouldViolate}. */
export function describeAlterColumn(change: AlterColumnAttributes): string {
	const attribute = change.setCollation !== undefined ? `set collate ${change.setCollation}`
		: change.setNotNull !== undefined ? (change.setNotNull ? 'set not null' : 'drop not null')
		: change.setDataType !== undefined ? `set data type ${change.setDataType}`
		: change.setDefault === null ? 'drop default'
		: 'set default';
	return `alter column ${change.columnName} ${attribute}`;
}

/**
 * Runs `probe` over each restorable state on its own and rewraps a `CONSTRAINT` or `MISMATCH`
 * it raises — the statuses the same probe gives a violation among the rows the transaction can
 * see — as {@link rolledBackRowsWouldViolate}. Any other failure propagates: it is a fault, not a
 * data condition. The caller judges the effective rows FIRST, so a violation the transaction can
 * see keeps its own status and only one confined to a restorable state becomes `BUSY`.
 */
export async function judgeRestorableStates<S>(
	states: readonly S[],
	probe: (state: S) => void | Promise<void>,
	ddl: string,
	tableName: string,
): Promise<void> {
	for (const state of states) {
		try {
			await probe(state);
		} catch (e) {
			if (e instanceof QuereusError && (e.code === StatusCode.CONSTRAINT || e.code === StatusCode.MISMATCH)) {
				throw rolledBackRowsWouldViolate(ddl, tableName, e);
			}
			throw e;
		}
	}
}
