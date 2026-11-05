/**
 * Rows sync has never recorded: live rows with no `cv:` cell record, usually written
 * before sync attached. No sync path can see them, and a snapshot covering their table
 * deletes them, so a client looks here before taking a snapshot nobody explicitly asked
 * for, and can record them as local changes instead (docs/sync.md § Rows sync has never
 * recorded).
 *
 * Finding them is strictly read-only. In particular `hasRowVersions` resolves a table's
 * generation without minting one, so a table with no `tg:` record simply reads as
 * unrecorded.
 *
 * Also here: the definition a write to such a table has to carry. A table created before
 * sync attached has no migration bringing it into existence, so its first recorded fact
 * is announced with a create for the table and its indexes ({@link announcementFor}),
 * which local capture records alongside the fact.
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
import type { AdoptedRows } from './manager.js';
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

/** A table that may hold unrecorded rows. */
interface CheckedTable {
	schema: string;
	table: string;
	keyColumns: readonly string[];
	definition: TableSchema;
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
function tablesToCheck(ctx: SyncContext, db: Database): CheckedTable[] {
	const tables: CheckedTable[] = [];
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
 * of an inserted row, and of the first edit of an unrecorded one, so a recorded row
 * always has at least one cell.
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
		if (!(await ctx.columnVersions.hasRowVersions(schema, table, pk))) return pk;
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
): Promise<AdoptedRows> {
	const adopted: AdoptedRows = { tables: [], rows: 0 };
	const db = ctx.db;
	if (!db || !ctx.applyToStore) {
		console.warn('[Sync] adoptUnrecordedRows did nothing: this peer has no engine to read rows through');
		return adopted;
	}
	if ((await listSnapshotCheckpoints(ctx)).length > 0) {
		throw new Error('Cannot adopt unrecorded rows while a snapshot is partly applied: its cleared metadata makes every row look unrecorded');
	}

	for (const { schema, table, definition } of tablesToCheck(ctx, db)) {
		if (!receiversCanWrite(definition)) {
			console.warn(`[Sync] Not adopting ${schema}.${table}: other devices cannot write to a table using module '${definition.vtabModuleName}'`);
			continue;
		}
		const rows = await adoptTable(ctx, db, definition, record);
		if (rows > 0) {
			adopted.tables.push({ schema, table });
			adopted.rows += rows;
		}
	}
	return adopted;
}

/**
 * Whether a receiver could apply this table's rows. The apply path writes only to store
 * tables, directly or through a wrapper exposing the store as `underlying`, the ownership
 * rule of `StoreModule.getTableForExternalWrite`. One row of any other table fails the
 * receiver's whole batch, so it would stop every other device from syncing and every new
 * device from bootstrapping. Such a table cannot sync in any direction today, so local
 * capture records nothing for it either (`SyncManagerImpl.filterCapturableDataEvents`).
 */
export function receiversCanWrite(table: TableSchema): boolean {
	const writable = (module: unknown): boolean =>
		typeof (module as { getTableForExternalWrite?: unknown } | undefined)?.getTableForExternalWrite === 'function';
	const module: unknown = table.vtabModule;
	return writable(module) || writable((module as { underlying?: unknown } | undefined)?.underlying);
}

/**
 * Adopt one table's unrecorded rows, `DATA_FLUSH_SIZE` to a synthetic transaction, so no
 * table has to fit in memory and a crash loses only the unfinished batch. Writing under
 * the open scan is safe: `record` writes to the sync KV store, not to the table. The
 * table's definition travels with the first batch as it does with any write to a table
 * nobody announced: `record` is local capture, which announces it (`announcementFor`).
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
		await record({ schemaEvents: [], dataEvents: pending });
		adopted += pending.length;
		pending = [];
	};

	for await (const row of scanLiveColumns(db, table.schemaName, table.name, columns)) {
		assertNoExplicitTransaction(db);
		const pk = table.primaryKeyDefinition.map(({ index }) => row[index]);
		if (await ctx.columnVersions.hasRowVersions(table.schemaName, table.name, pk)) continue;
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
 * The `create` events to record with the first fact of a table whose migrations never
 * brought it into existence, and how to record them. The coordinator keeps no table
 * definitions, so a cell for a table nobody announced is quarantined by another device
 * and aborts a new device's snapshot (docs/sync-unknown-tables.md § Unknown-Table Disposition).
 */
export interface TableAnnouncement {
	/**
	 * `baseline`: nothing recorded ever created the table, so it is announced at
	 * schema version 0 (`SchemaMigration.schemaVersion`): a definition for devices that
	 * have none, which a device holding the table keeps its own shape over.
	 * `ordinary`: the table's own stream ends on a drop (dropped under sync, re-created
	 * while detached), so this is a real new table, recorded as the next version with
	 * the usual conflict rule. A baseline there would sort ahead of the drop it follows.
	 */
	readonly kind: 'baseline' | 'ordinary';
	/** The table's create, then one per index, in the shape the store module emits. */
	readonly events: DatabaseSchemaChangeEvent[];
}

/**
 * What to announce for `table`, or nothing when its migrations already bring it into
 * existence and leave it there. `streamName` is the name whose migrations decide: the
 * table's own, or the name it had before a rename in the transaction being recorded,
 * which storage has not seen yet.
 *
 * The DDL is what the store module puts on its own create events: no `db` argument, so
 * fully qualified, and byte-identical across devices announcing the same table. Every
 * index is announced with its table, whatever the index's own migrations say: a receiver
 * that replays an older `add_index` ahead of this create finds no table and converges
 * without the index, and a baseline index runs only where the table itself came from the
 * baseline (`store-adapter.ts` § `decideSchemaChange`).
 */
export async function announcementFor(ctx: SyncContext, table: TableSchema, streamName: string): Promise<TableAnnouncement | undefined> {
	const state = await migrationStreamState(ctx, table.schemaName, 'table', streamName);
	if (state === 'live') return undefined;
	return { kind: state === 'dropped' ? 'ordinary' : 'baseline', events: createEvents(table) };
}

function createEvents(table: TableSchema): DatabaseSchemaChangeEvent[] {
	const { schemaName, name, vtabModuleName: moduleName } = table;
	const events: DatabaseSchemaChangeEvent[] = [
		{ type: 'create', objectType: 'table', moduleName, schemaName, objectName: name, ddl: generateTableDDL(table), remote: false },
	];
	for (const index of table.indexes ?? []) {
		if (isHiddenImplicitIndex(table, index.name)) continue;
		events.push({ type: 'create', objectType: 'index', moduleName, schemaName, objectName: index.name, ddl: generateIndexDDL(index, table), remote: false });
	}
	return events;
}

/**
 * How an object's recorded migrations leave it:
 *
 * - `live`: brought into existence and left there.
 * - `dropped`: its own stream ends on a drop. Dropped under sync and re-created while
 *   detached, if the object exists now.
 * - `unrecorded`: nothing recorded brings it into existence. Created before sync
 *   attached, and perhaps renamed or altered since.
 *
 * A version count would not do: a table created before sync attached and altered since
 * has only an `alter_column`. A `rename_table` files under the new name with the old one
 * in `fromTable`, so it counts as live exactly when the old name's stream is live.
 *
 * NOTE: a rename chain returning to a name it already visited (renamed away and back)
 * reads as `unrecorded`, because a version-ordered walk cannot tell whether that name's
 * create came before or after the rename back. The cost is a baseline every receiver keeps
 * its own table over, never a missing definition.
 *
 * NOTE: streams can also read live after the object has gone. A rename files under the new
 * name, so a table renamed away leaves its old name's stream ending on `create_table`, and
 * `drop table` records no `drop_index`, so a dropped table's index stream ends on
 * `add_index`. A table or index created under such a name while detached is then not
 * announced. If that shows up, compare against the owning table's latest create.
 */
export type MigrationStreamState = 'live' | 'dropped' | 'unrecorded';

export async function migrationStreamState(
	ctx: SyncContext,
	schema: string,
	kind: SchemaObjectKind,
	name: string,
	visited: Set<string> = new Set(),
): Promise<MigrationStreamState> {
	if (visited.has(name)) return 'unrecorded';
	visited.add(name);
	let state: MigrationStreamState = 'unrecorded';
	for await (const { type, fromTable } of ctx.schemaMigrations.getAllMigrations(schema, kind, name)) {
		if (type === 'create_table' || type === 'add_index') {
			state = 'live';
		} else if (type === 'rename_table') {
			const from = fromTable === undefined ? 'unrecorded' : await migrationStreamState(ctx, schema, kind, fromTable, visited);
			state = from === 'live' ? 'live' : 'unrecorded';
		} else if (type === 'drop_table' || type === 'drop_index') {
			state = 'dropped';
		}
	}
	return state;
}
