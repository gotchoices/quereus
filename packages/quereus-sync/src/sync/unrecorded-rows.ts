/**
 * Finding rows sync has never recorded: live rows with no `cv:` cell record, usually
 * written before sync attached. No sync path can see them, and a snapshot covering
 * their table deletes them, so a client looks here before taking a snapshot nobody
 * explicitly asked for (docs/sync.md § Rows sync has never recorded).
 *
 * Strictly read-only. In particular `getRowVersions` resolves a table's generation
 * without minting one, so a table with no `tg:` record simply reads as unrecorded.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { encodePkIdentity } from '../metadata/keys.js';
import { scanLiveKeys } from './snapshot-coverage.js';
import type { SyncContext } from './sync-context.js';

/**
 * The tables holding at least one unrecorded row. Empty where a snapshot could not
 * delete anything anyway, the same conditions under which
 * `removeRowsAbsentFromSnapshot` does nothing: no engine or no way to write to it.
 */
export async function findTablesWithUnrecordedRows(ctx: SyncContext): Promise<Array<{ schema: string; table: string }>> {
	const db = ctx.db;
	if (!db || !ctx.applyToStore) return [];

	await writesSettled(ctx);

	const found: Array<{ schema: string; table: string }> = [];
	for (const { schema, table, keyColumns } of tablesToCheck(ctx, db)) {
		if (await holdsUnrecordedRow(ctx, db, schema, table, keyColumns)) found.push({ schema, table });
	}
	return found;
}

/**
 * Every table a snapshot could delete unrecorded rows from. A materialized view's rows
 * are derived and never carry cells. A memory table has no external write path, so a
 * snapshot can never delete from it (see the NOTE on `removeRowsAbsentFromSnapshot`).
 *
 * NOTE: memory is excluded by name rather than store modules included by name, so a
 * wrapped or renamed store module is still checked and a wrong guess costs a refusal
 * instead of lost data. A custom module's rows therefore refuse too. If a local-only
 * module becomes common, let tables opt out rather than widening this name check.
 */
function tablesToCheck(ctx: SyncContext, db: Database): Array<{ schema: string; table: string; keyColumns: readonly string[] }> {
	const tables: Array<{ schema: string; table: string; keyColumns: readonly string[] }> = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const { schemaName, name, vtabModuleName } of schema.getAllTables()) {
			if (!ctx.isTableInBasis(schemaName, name) || ctx.isMaterializedView(schemaName, name)) continue;
			if (vtabModuleName.toLowerCase() === 'memory') continue;
			const keyColumns = ctx.getTableKeyColumns(schemaName, name);
			if (keyColumns) tables.push({ schema: schemaName, table: name, keyColumns });
		}
	}
	return tables;
}

/**
 * Whether the table has a row that stays unrecorded once in-flight writes finish: two
 * scans, with those writes settled between them, must name the same row. A false answer
 * stops sync, and a row can look unrecorded for a moment in three ways: a local commit's
 * recording queues behind the commit, a remote apply writes the row before its records,
 * and a committed-read scan still yields a row whose delete has removed its records.
 *
 * The wait sits between scans, never inside one. The store module has no committed-read
 * support, so its scan holds the engine's execution mutex until it closes, and an apply
 * (or a re-key on the commit chain) needs that mutex to finish.
 */
async function holdsUnrecordedRow(
	ctx: SyncContext,
	db: Database,
	schema: string,
	table: string,
	keyColumns: readonly string[],
): Promise<boolean> {
	const keying = ctx.getPkKeying(schema, table);
	let suspect: string | undefined;
	for (;;) {
		const pk = await firstUnrecordedKey(ctx, db, schema, table, keyColumns);
		if (!pk) return false;
		const identity = encodePkIdentity(pk, keying);
		if (identity === suspect) return true;
		suspect = identity;
		await writesSettled(ctx);
	}
}

/**
 * The key of the first live row with no cell record. Local capture records every column
 * of an inserted row, so a recorded row always has at least one cell.
 *
 * NOTE: one `cv:` range read per recorded row, and on the store module all of them under
 * the execution mutex, so a fully recorded table blocks writers for its whole scan. It
 * runs rarely: on a first connect, which stops at the first row or has none, and on
 * `snapshot_required`. If it ever shows up there, read the table's `cv:` identities first
 * and scan against that set, as the snapshot footer's `filedRowIdentities` does.
 *
 * NOTE: inside an open explicit transaction this read takes the serialized path and sees
 * that transaction's uncommitted rows, which have no records yet and so look unrecorded.
 * The result is a refusal the next `connect()` clears. If apps hit this while connecting
 * mid-transaction, wait for the transaction here.
 */
async function firstUnrecordedKey(
	ctx: SyncContext,
	db: Database,
	schema: string,
	table: string,
	keyColumns: readonly string[],
): Promise<SqlValue[] | undefined> {
	for await (const pk of scanLiveKeys(db, schema, table, keyColumns)) {
		const versions = await ctx.columnVersions.getRowVersions(schema, table, pk);
		if (versions.size === 0) return pk;
	}
	return undefined;
}

async function writesSettled(ctx: SyncContext): Promise<void> {
	await ctx.whenCommitsSettled();
	await ctx.whenAppliesSettled();
}
