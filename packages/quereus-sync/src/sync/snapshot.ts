/**
 * Non-streaming snapshot operations.
 *
 * Full in-memory snapshot get/apply for small databases
 * or when streaming is not needed.
 */

import type { SqlValue, Row } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import { deserializeColumnVersion, type ColumnVersion } from '../metadata/column-version.js';
import { deserializeMigration } from '../metadata/schema-migration.js';
import {
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	buildAllChangeLogScanBounds,
	parseColumnVersionKey,
	parseSchemaMigrationKey,
	encodePK,
} from '../metadata/keys.js';
import type {
	Snapshot,
	SchemaMigration,
	TableSnapshot,
	DataChangeToApply,
	SchemaChangeToApply,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { admitGroup } from './admission.js';

/**
 * Get a full snapshot of all data and schema state.
 */
export async function getSnapshot(ctx: SyncContext): Promise<Snapshot> {
	// Collect all column versions, grouped by table and row
	type RowVersions = Map<string, ColumnVersion>;
	type TableRows = Map<string, RowVersions>;
	const tableData = new Map<string, TableRows>();

	const cvBounds = buildAllColumnVersionsScanBounds();
	for await (const entry of ctx.kv.iterate(cvBounds)) {
		const parsed = parseColumnVersionKey(entry.key);
		if (!parsed) continue;

		const cv = deserializeColumnVersion(entry.value);
		const tableKey = `${parsed.schema}.${parsed.table}`;
		const rowKey = encodePK(parsed.pk);

		if (!tableData.has(tableKey)) {
			tableData.set(tableKey, new Map());
		}
		const tableRows = tableData.get(tableKey)!;

		if (!tableRows.has(rowKey)) {
			tableRows.set(rowKey, new Map());
		}
		const rowVersions = tableRows.get(rowKey)!;
		rowVersions.set(parsed.column, cv);
	}

	// Build table snapshots
	const tables: TableSnapshot[] = [];
	for (const [tableKey, rows] of tableData) {
		const [schema, table] = tableKey.split('.');
		const columnVersions = new Map<string, { hlc: HLC; value: SqlValue }>();
		const rowsArray: Row[] = [];

		for (const [rowKey, rowVersionsMap] of rows) {
			const row: Row = Array.from(rowVersionsMap.values()).map(cv => cv.value);
			rowsArray.push(row);

			for (const [column, cv] of rowVersionsMap) {
				const versionKey = `${rowKey}:${column}`;
				columnVersions.set(versionKey, { hlc: cv.hlc, value: cv.value });
			}
		}

		tables.push({
			schema,
			table,
			rows: rowsArray,
			columnVersions,
		});
	}

	// Collect all schema migrations
	const schemaMigrations: SchemaMigration[] = [];
	const smBounds = buildAllSchemaMigrationsScanBounds();
	for await (const entry of ctx.kv.iterate(smBounds)) {
		const parsed = parseSchemaMigrationKey(entry.key);
		if (!parsed) continue;

		const migration = deserializeMigration(entry.value);
		schemaMigrations.push({
			type: migration.type,
			schema: parsed.schema,
			table: parsed.table,
			ddl: migration.ddl,
			hlc: migration.hlc,
			schemaVersion: migration.schemaVersion,
		});
	}

	return {
		siteId: ctx.getSiteId(),
		hlc: ctx.getCurrentHLC(),
		tables,
		schemaMigrations,
	};
}

/**
 * Apply a full snapshot, replacing all local data.
 */
export async function applySnapshot(
	ctx: SyncContext,
	snapshot: Snapshot,
): Promise<void> {
	// PHASE 1: Build data changes from snapshot
	const dataChangesToApply: DataChangeToApply[] = [];
	const schemaChangesToApply: SchemaChangeToApply[] = [];

	for (const migration of snapshot.schemaMigrations) {
		schemaChangesToApply.push({
			type: migration.type,
			schema: migration.schema,
			table: migration.table,
			ddl: migration.ddl,
		});
	}

	for (const tableSnapshot of snapshot.tables) {
		const rowsByPk = new Map<string, Record<string, SqlValue>>();

		for (const [versionKey, cvEntry] of tableSnapshot.columnVersions) {
			const lastColon = versionKey.lastIndexOf(':');
			if (lastColon === -1) continue;

			const rowKey = versionKey.slice(0, lastColon);
			const column = versionKey.slice(lastColon + 1);

			if (!rowsByPk.has(rowKey)) {
				rowsByPk.set(rowKey, {});
			}
			rowsByPk.get(rowKey)![column] = cvEntry.value;
		}

		for (const [rowKey, columns] of rowsByPk) {
			const pk = JSON.parse(rowKey) as SqlValue[];
			dataChangesToApply.push({
				type: 'update',
				schema: tableSnapshot.schema,
				table: tableSnapshot.table,
				pk,
				columns,
			});
		}
	}

	// Admit the snapshot as one wholesale all-or-nothing unit: data first (PHASE 2,
	// a bootstrap apply — the adapter skips the engine seam, converged once by the
	// finalize below), then the wholesale metadata replace (PHASE 3), then the
	// clock watermark. A data-apply failure aborts before clearing/rewriting
	// metadata, leaving prior CRDT state intact; the snapshot retries wholesale
	// (idempotent on the store side) and now also emits status:'error'.
	await admitGroup(ctx, {
		dataChanges: dataChangesToApply,
		schemaChanges: schemaChangesToApply,
		applyOptions: { remote: true, bootstrap: true },
		commitMetadata: async () => {
			// Clear existing CRDT metadata and apply new
			const clearBatch = ctx.kv.batch();

			for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) {
				clearBatch.delete(entry.key);
			}
			for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
				clearBatch.delete(entry.key);
			}
			for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds())) {
				clearBatch.delete(entry.key);
			}

			await clearBatch.write();

			// Apply snapshot's column versions and rebuild change log
			const applyBatch = ctx.kv.batch();

			for (const tableSnapshot of snapshot.tables) {
				for (const [versionKey, cvEntry] of tableSnapshot.columnVersions) {
					const lastColon = versionKey.lastIndexOf(':');
					if (lastColon === -1) continue;

					const rowKey = versionKey.slice(0, lastColon);
					const column = versionKey.slice(lastColon + 1);
					const pk = JSON.parse(rowKey) as SqlValue[];

					ctx.columnVersions.setColumnVersionBatch(
						applyBatch,
						tableSnapshot.schema,
						tableSnapshot.table,
						pk,
						column,
						{ hlc: cvEntry.hlc, value: cvEntry.value },
					);

					ctx.changeLog.recordColumnChangeBatch(
						applyBatch,
						cvEntry.hlc,
						tableSnapshot.schema,
						tableSnapshot.table,
						pk,
						column,
					);
				}
			}

			// Record schema migrations
			for (const migration of snapshot.schemaMigrations) {
				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
			}

			await applyBatch.write();
		},
		watermarkHLC: snapshot.hlc,
	});

	// Converge the bootstrap: PHASE 2 deferred MV maintenance and watch capture
	// (seam skipped), so converge every MV once and coarse-notify each
	// bootstrapped table's watchers. Issued before `status: 'synced'` so a
	// finalize failure aborts the apply (the storage rows are already correct, so
	// a retry's finalize rebuilds cleanly).
	if (ctx.applyToStore) {
		await ctx.applyToStore([], [], {
			remote: true,
			bootstrapFinalize: true,
			bootstrapTables: snapshot.tables.map(t => ({ schema: t.schema, table: t.table })),
		});
	}

	// Emit sync state change
	ctx.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshot.hlc });
}
