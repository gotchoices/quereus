/**
 * Rows sync has never recorded: live rows with no `cv:` cell record, usually written
 * before sync attached. No sync path can see them, and a snapshot covering their table
 * deletes them, so a client looks here before taking a snapshot nobody explicitly asked
 * for, and can record them as local changes instead (docs/sync.md § Rows sync has never
 * recorded).
 *
 * Finding them is strictly read-only. In particular `getRowVersions` resolves a table's
 * generation without minting one, so a table with no `tg:` record simply reads as
 * unrecorded.
 */

import {
	generateIndexDDL,
	generateTableDDL,
	isHiddenImplicitIndex,
	type Database,
	type DatabaseDataChangeEvent,
	type DatabaseSchemaChangeEvent,
	type Row,
	type SqlValue,
	type TableSchema,
	type TransactionCommitBatch,
} from '@quereus/quereus';
import { encodePkIdentity } from '../metadata/keys.js';
import type { SchemaObjectKind } from './protocol.js';
import { DATA_FLUSH_SIZE, scanLiveColumns } from './snapshot-coverage.js';
import { listSnapshotCheckpoints } from './snapshot-checkpoint.js';
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
 * instead of lost data. A custom module's rows therefore refuse too, engine-managed
 * tables (`quereus.engine_managed`) included. If a local-only module becomes common, let
 * tables opt out rather than widening this name check.
 */
function tablesToCheck(
	ctx: SyncContext,
	db: Database,
): Array<{ schema: string; table: string; keyColumns: readonly string[]; definition: TableSchema }> {
	const tables: Array<{ schema: string; table: string; keyColumns: readonly string[]; definition: TableSchema }> = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const definition of schema.getAllTables()) {
			const { schemaName, name, vtabModuleName } = definition;
			if (!ctx.isTableInBasis(schemaName, name) || ctx.isMaterializedView(schemaName, name)) continue;
			if (vtabModuleName.toLowerCase() === 'memory') continue;
			const keyColumns = ctx.getTableKeyColumns(schemaName, name);
			if (keyColumns) tables.push({ schema: schemaName, table: name, keyColumns, definition });
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
	let suspect: string | undefined;
	for (;;) {
		const pk = await firstUnrecordedKey(ctx, db, schema, table, keyColumns);
		if (!pk) return false;
		const identity = encodePkIdentity(pk, ctx.getPkKeying(schema, table));
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
	for await (const pk of scanLiveColumns(db, schema, table, keyColumns)) {
		const versions = await ctx.columnVersions.getRowVersions(schema, table, pk);
		if (versions.size === 0) return pk;
	}
	return undefined;
}

async function writesSettled(ctx: SyncContext): Promise<void> {
	await ctx.whenCommitsSettled();
	await ctx.whenAppliesSettled();
}

/**
 * Record every unrecorded row through `record`, the local commit capture, so adopted rows
 * get the same HLCs, change-log entries and events as any other local write.
 *
 * Runs on the commit chain, so it must not wait for commits or applies from in here (see
 * `SyncManagerImpl.adoptUnrecordedRows`). A local commit queued meanwhile lands afterwards
 * and overwrites with a newer HLC, as it would any earlier write.
 */
export async function adoptUnrecordedRows(
	ctx: SyncContext,
	record: (batch: TransactionCommitBatch) => Promise<void>,
): Promise<{ tables: Array<{ schema: string; table: string }>; rows: number }> {
	const adopted = { tables: [] as Array<{ schema: string; table: string }>, rows: 0 };
	const db = ctx.db;
	if (!db || !ctx.applyToStore) {
		console.warn('[Sync] adoptUnrecordedRows did nothing: this peer has no engine to read rows through');
		return adopted;
	}
	if ((await listSnapshotCheckpoints(ctx)).length > 0) {
		throw new Error('Cannot adopt unrecorded rows while a snapshot is partly applied: its cleared metadata makes every row look unrecorded');
	}

	for (const { schema, table, definition } of tablesToCheck(ctx, db)) {
		const rows = await adoptTable(ctx, db, definition, record);
		if (rows > 0) {
			adopted.tables.push({ schema, table });
			adopted.rows += rows;
		}
	}
	return adopted;
}

/**
 * Adopt one table's unrecorded rows, `DATA_FLUSH_SIZE` to a synthetic transaction, so no
 * table has to fit in memory and a crash loses only the unfinished batch. Writing under
 * the open scan is safe: `record` writes to the sync KV store, not to the table.
 *
 * NOTE: a table with more columns than `batchSize / DATA_FLUSH_SIZE` (10 by default) makes
 * each batch an oversized transaction, which is sent whole and logs a warning per read. If
 * that noise matters, size the batches by cells instead of rows.
 *
 * NOTE: on the store module the open scan holds the execution mutex, so the app's writes
 * wait for each table to finish, as under `firstUnrecordedKey` but with the recording added.
 * Not measured. If a large first attach shows it, read the rows in key-ordered pages and
 * release the mutex between them.
 */
async function adoptTable(
	ctx: SyncContext,
	db: Database,
	table: TableSchema,
	record: (batch: TransactionCommitBatch) => Promise<void>,
): Promise<number> {
	const columns = table.columns.map(column => column.name);
	let adopted = 0;
	let pending: DatabaseDataChangeEvent[] = [];
	const flush = async (): Promise<void> => {
		// With the first row, so a table with nothing to send sends no schema either.
		const schemaEvents = adopted === 0 ? await missingCreateEvents(ctx, table) : [];
		await record({ schemaEvents, dataEvents: pending });
		adopted += pending.length;
		pending = [];
	};

	for await (const row of scanLiveColumns(db, table.schemaName, table.name, columns)) {
		assertNoExplicitTransaction(db);
		const pk = table.primaryKeyDefinition.map(({ index }) => row[index]);
		const versions = await ctx.columnVersions.getRowVersions(table.schemaName, table.name, pk);
		if (versions.size > 0) continue;
		pending.push(insertEvent(table, pk, row));
		if (pending.length >= DATA_FLUSH_SIZE) await flush();
	}
	if (pending.length > 0) await flush();
	return adopted;
}

/**
 * Checked with the scan open: on the store module that scan holds the execution mutex, so
 * no transaction can begin between this check and the row it guards. An uncommitted row
 * looks unrecorded, and recording one that then rolls back would send every other device
 * a row this one does not have. The client retries through its reconnect.
 */
function assertNoExplicitTransaction(db: Database): void {
	if (!db.getAutocommit() && !db._isImplicitTransaction()) {
		throw new Error('Cannot adopt unrecorded rows while a transaction is open: its uncommitted rows look unrecorded');
	}
}

function insertEvent(table: TableSchema, pk: SqlValue[], row: Row): DatabaseDataChangeEvent {
	return {
		type: 'insert',
		moduleName: table.vtabModuleName,
		schemaName: table.schemaName,
		tableName: table.name,
		key: pk,
		newRow: row,
		remote: false,
	};
}

/**
 * The `create` events a table and its indexes lack. The coordinator keeps no table
 * definitions, so a cell for a table nobody announced is quarantined by another device
 * and aborts a new device's snapshot (docs/sync.md § Unknown-Table Disposition).
 * The DDL is what the store module puts on its own create events: no `db` argument, so
 * fully qualified, and byte-identical across devices adopting the same table.
 */
async function missingCreateEvents(ctx: SyncContext, table: TableSchema): Promise<DatabaseSchemaChangeEvent[]> {
	const { schemaName, name, vtabModuleName: moduleName } = table;
	const events: DatabaseSchemaChangeEvent[] = [];
	if (!await hasLiveCreate(ctx, schemaName, 'table', name)) {
		events.push({ type: 'create', objectType: 'table', moduleName, schemaName, objectName: name, ddl: generateTableDDL(table), remote: false });
	}
	for (const index of table.indexes ?? []) {
		if (isHiddenImplicitIndex(table, index.name) || await hasLiveCreate(ctx, schemaName, 'index', index.name)) continue;
		events.push({ type: 'create', objectType: 'index', moduleName, schemaName, objectName: index.name, ddl: generateIndexDDL(index, table), remote: false });
	}
	return events;
}

/**
 * Whether the object's migrations bring it into existence and leave it there. A version
 * count would not do: a table created before sync attached and altered since has only an
 * `alter_column`, and one dropped under sync and re-created while detached ends on its
 * `drop_table`. Either way a receiver replaying them ends with no table.
 *
 * NOTE: a rename counts as a create, on the assumption that the old name's stream holds
 * one. A table created before sync attached and renamed since breaks that: a receiver has
 * neither name, so it converges without a table. If that shows up, follow `fromTable`.
 */
async function hasLiveCreate(ctx: SyncContext, schema: string, kind: SchemaObjectKind, name: string): Promise<boolean> {
	let live = false;
	for await (const { type } of ctx.schemaMigrations.getAllMigrations(schema, kind, name)) {
		if (type === 'create_table' || type === 'add_index' || type === 'rename_table') live = true;
		else if (type === 'drop_table' || type === 'drop_index') live = false;
	}
	return live;
}
