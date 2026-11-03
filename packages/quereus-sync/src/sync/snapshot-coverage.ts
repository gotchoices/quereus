/**
 * What a snapshot COVERS, and what covering a table means.
 *
 * A snapshot replaces what the replica holds, one table at a time: after an apply,
 * a table the snapshot has a section for holds exactly the snapshot's rows, and a
 * table with no section is left alone (the snapshot simply knows nothing about it).
 * A row the sender deleted and pruned long ago appears nowhere in a snapshot, so its
 * absence from a section is the only thing that can remove it from a replica that
 * fell behind.
 *
 * That makes an empty section meaningful, and the two halves here keep it so: the
 * sender announces every table it hosts, cells or not, and the receiver deletes what
 * a section does not carry. See docs/sync.md § Snapshots replace rows.
 */

import { quoteIdentifier, type Database, type SqlValue } from '@quereus/quereus';
import { encodePkIdentity, type PkKeying } from '../metadata/keys.js';
import { applyDataToStore } from './admission.js';
import type { DataChangeToApply } from './protocol.js';
import type { SyncContext } from './sync-context.js';

/**
 * Row changes a snapshot apply pushes to the store at a time.
 *
 * Exported so specs that must exceed this bound (to exercise a mid-table flush)
 * derive their row counts from it rather than restating the literal.
 */
export const DATA_FLUSH_SIZE = 100;

/**
 * The tables a producer must give a section even with no cell left. Deleting a row
 * removes its cells and pruning removes its tombstone, so an emptied table leaves no
 * record for a `cv:` scan to find, but its `tg:` name → generation record outlives
 * the rows and is retired by a drop: that is what separates "emptied" from "never
 * hosted". The basis check stops a stale `tg:` record (a table dropped while sync was
 * detached; see `TableIdentityStore.ensure`) from wiping a receiver's table.
 */
export function tablesToAnnounce(ctx: SyncContext): Array<{ generation: string; schema: string; table: string }> {
	return ctx.tableIdentity.liveTables().filter(({ schema, table }) => ctx.isTableInBasis(schema, table));
}

/**
 * Delete every row of `(schema, table)` whose identity is not in `keep`, through the
 * same seam as a snapshot's other row writes: secondary indexes and stats follow, the
 * events are `remote` so nothing is re-recorded, and materialized views and watchers
 * converge at the caller's `bootstrapFinalize`, which must run after this.
 *
 * A row removed here had no sync metadata the snapshot would keep, so this is also
 * what removes a local row the replica never pushed (docs/sync.md § Snapshots replace
 * rows). A relay-only peer has no row data, so there is nothing to do there.
 *
 * A materialized view is skipped: its rows are derived and never carry cells, so its
 * section is always empty and says nothing about its contents, and it may have no
 * external write path at all. `bootstrapFinalize` rebuilds it from the replaced rows.
 * The guard is here rather than in `tablesToAnnounce` because a relay has no catalog:
 * it announces a view on the strength of the view's `create_table` migration.
 *
 * NOTE: a base table outside the store module (`using memory`) has no external write
 * path, so an absent row in one aborts the apply with "Table not found for external
 * write", as a section with cells for such a table already does. A table like that
 * with rows cannot sync today in any direction; if that ever becomes supported, skip
 * such tables here too, or an empty one on the sender will fail its receivers.
 */
export async function removeRowsAbsentFromSnapshot(
	ctx: SyncContext,
	schema: string,
	table: string,
	keying: PkKeying,
	keep: { has(identity: string): boolean },
): Promise<void> {
	if (!ctx.applyToStore || ctx.isMaterializedView(schema, table)) return;

	const keyColumns = ctx.getTableKeyColumns(schema, table);
	if (!ctx.db || !keyColumns) {
		console.warn(
			`[Sync] ${schema}.${table}: rows absent from the snapshot cannot be removed on this peer `
				+ `(no engine or table schema here to read the table through) — they stay, with no sync metadata`,
		);
		return;
	}

	// Collected before the first write, so nothing writes under an open scan.
	const absent = await collectAbsentKeys(ctx.db, schema, table, keyColumns, keying, keep);
	for (let i = 0; i < absent.length; i += DATA_FLUSH_SIZE) {
		const deletes = absent.slice(i, i + DATA_FLUSH_SIZE).map((pk): DataChangeToApply => ({ type: 'delete', schema, table, pk }));
		await applyDataToStore(ctx, deletes, [], { remote: true, bootstrap: true });
	}
}

/** The key of every live row whose identity is not in `keep`. */
async function collectAbsentKeys(
	db: Database,
	schema: string,
	table: string,
	keyColumns: readonly string[],
	keying: PkKeying,
	keep: { has(identity: string): boolean },
): Promise<SqlValue[][]> {
	const absent: SqlValue[][] = [];
	for await (const pk of scanLiveColumns(db, schema, table, keyColumns)) {
		if (!keep.has(encodePkIdentity(pk, keying))) absent.push(pk);
	}
	return absent;
}

/**
 * The named columns of every live row, in the order named. They are selected under
 * positional aliases, as `scanLiveRows` in `rekey-on-pk-change.ts` does, so the projection
 * never depends on how the engine spells a column. A singleton table (`primary key ()`)
 * has no key column to select, so a constant stands in and its one row's key is `[]`.
 */
export async function* scanLiveColumns(
	db: Database,
	schema: string,
	table: string,
	columns: readonly string[],
): AsyncGenerator<SqlValue[]> {
	const projection = columns.length > 0
		? columns.map((name, i) => `${quoteIdentifier(name)} as c${i}`).join(', ')
		: '1 as c0';
	const sql = `select ${projection} from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

	for await (const row of db.eval(sql, undefined, { readConcurrency: 'committed' })) {
		yield columns.map((_, i) => row[`c${i}`]);
	}
}
