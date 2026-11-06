/**
 * The cells and rows local commits change while a remote apply is in flight.
 *
 * An apply decides each incoming cell against the cell's stored record (Phase 1), writes
 * the rows (Phase 2), and files the records last (Phase 3). A local commit landing in
 * between happened after this replica received the batch, and the apply merged the batch's
 * clock before Phase 1, so the commit's capture ticks above every fact in it: by
 * last-writer-wins the local write is the newer one. The apply registers a tracker before
 * merging the clock; the manager fills it synchronously inside each local engine commit;
 * the data write and the filing both skip whatever it reports, so the row and its records
 * honour one decision (docs/sync-transactions.md § Local writes during an apply).
 *
 * Two kinds of mark:
 *
 * - a CELL: a local update changed this column's value;
 * - a REPLACED ROW: a local delete or insert of this key. The row as the batch saw it is
 *   gone or was never here, so every incoming fact for it loses: its column changes, and
 *   an incoming delete, which the local tombstone or the newly inserted row supersedes.
 *
 * An incoming delete still beats local CELL edits: a delete is compared only with
 * tombstones (`resolveChange`), and its cleanup removes the row's cell records.
 *
 * Marks only ever accumulate, so whatever the data write skipped, the filing (which reads
 * the tracker later) skips too.
 *
 * NOTE: an explicit local transaction that READS a row before the data write and commits
 * after it writes its full stale row image back through the store's transaction
 * coordinator, clobbering the batch's untracked cells of that row while filing records the
 * incoming values. The store adapter already requires hosts not to drive an apply inside
 * their own open transaction; this is the concurrent form of that. If it ever matters,
 * mark every cell of a row written by a transaction that was open across the data write.
 *
 * NOTE: capture records EVERY column on the first edit of a row sync has no records for,
 * but only the CHANGED cells are marked here. For an unchanged column the data write and
 * the filing both use the incoming value, and the filing re-reads (and so replaces) the
 * capture's record of it; the two agree. Do not mark every column to "match" capture: the
 * data write would then skip cells the filing files.
 *
 * NOTE: under `allowResurrection`, a batch carrying a delete and a resurrecting write for one
 * row, plus a local edit of that row landing after the data write, can lose the edit's cell
 * record: the delete's cleanup runs after filing, off the commit chain, and sweeps whatever
 * records the row has by then. If that combination ever shows up, record when each mark was
 * taken relative to the data write and spare the later ones in the cleanup.
 */

import type { SqlValue } from '@quereus/quereus';
import { encodePkIdentity, joinKeyParts, type PkKeying } from '../metadata/keys.js';

export class LocalWriteTracker {
	private readonly cells = new Set<string>();
	private readonly replacedRows = new Set<string>();
	private closed = false;

	/**
	 * @param keyingOf the pk-identity keying the metadata stores use, so two spellings of one
	 *   key under a key collation are one row here too.
	 * @param onClose unregisters the tracker from whatever fills it.
	 */
	constructor(
		private readonly keyingOf: (schema: string, table: string) => PkKeying,
		private readonly onClose: () => void,
	) {}

	/** Mark cells a local update changed. */
	noteCells(schema: string, table: string, pk: SqlValue[], columns: Iterable<string>): void {
		if (this.closed) return;
		const row = this.rowKey(schema, table, pk);
		for (const column of columns) this.cells.add(cellKey(row, column));
	}

	/** Mark a row a local delete or insert replaced. */
	noteRowReplaced(schema: string, table: string, pk: SqlValue[]): void {
		if (this.closed) return;
		this.replacedRows.add(this.rowKey(schema, table, pk));
	}

	/**
	 * Whether a local write made the incoming fact for this cell (`column` given) or this
	 * row's delete (`column` undefined) lose: the cell was marked or the row replaced.
	 */
	supersedes(schema: string, table: string, pk: SqlValue[], column?: string): boolean {
		if (this.cells.size === 0 && this.replacedRows.size === 0) return false;
		const row = this.rowKey(schema, table, pk);
		if (this.replacedRows.has(row)) return true;
		return column !== undefined && this.cells.has(cellKey(row, column));
	}

	/**
	 * Stop recording, freezing what {@link supersedes} answers. The filing calls this at the
	 * start of its commit-chain entry: a local commit after that point is captured after the
	 * filing, so it overwrites the filed record anyway. Idempotent.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose();
	}

	private rowKey(schema: string, table: string, pk: SqlValue[]): string {
		return joinKeyParts(schema.toLowerCase(), table.toLowerCase(), encodePkIdentity(pk, this.keyingOf(schema, table)));
	}
}

/** Column names compare case-insensitively, as the store adapter matches them to the table. */
function cellKey(row: string, column: string): string {
	return joinKeyParts(row, column.toLowerCase());
}
