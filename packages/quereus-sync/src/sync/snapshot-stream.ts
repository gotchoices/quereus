/**
 * Streaming snapshot operations.
 *
 * Handles chunked snapshot generation, application, and checkpoint
 * management for memory-efficient sync of large databases.
 */

import type { SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { deserializeColumnVersion } from '../metadata/column-version.js';
import { deserializeMigration } from '../metadata/schema-migration.js';
import {
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	buildAllChangeLogScanBounds,
	buildTableColumnVersionScanBounds,
	parseColumnVersionKey,
	parseSchemaMigrationKey,
	parseTombstoneKey,
	parseChangeLogKey,
	encodePK,
} from '../metadata/keys.js';
import type { SnapshotCheckpoint } from './manager.js';
import type {
	SnapshotChunk,
	SnapshotProgress,
	SnapshotHeaderChunk,
	SnapshotTableStartChunk,
	SnapshotColumnVersionsChunk,
	SnapshotTableEndChunk,
	SnapshotSchemaMigrationChunk,
	SnapshotFooterChunk,
	DataChangeToApply,
	SchemaChangeToApply,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, throwIfApplyErrors } from './sync-context.js';

/** Default chunk size for streaming snapshots. */
const DEFAULT_SNAPSHOT_CHUNK_SIZE = 1000;

/** Key prefix for snapshot checkpoints. */
const CHECKPOINT_PREFIX = 'sc:';

// ============================================================================
// Snapshot Generation
// ============================================================================

/**
 * Options for the shared snapshot streaming generator.
 */
interface StreamSnapshotOptions {
	snapshotId: string;
	siteId: SiteId;
	hlc: HLC;
	chunkSize: number;
	/** Tables to skip (already completed in a resumed transfer). */
	completedTables?: Set<string>;
	/** Initial entry count (for resumed transfers). */
	initialEntryCount?: number;
}

/**
 * Shared generator that streams snapshot chunks.
 *
 * Both `getSnapshotStream` and `resumeSnapshotStream` delegate here,
 * differing only in initial parameters (skip set, identity source, entry count).
 */
async function* streamSnapshotChunks(
	ctx: SyncContext,
	opts: StreamSnapshotOptions,
): AsyncIterable<SnapshotChunk> {
	const { snapshotId, siteId, hlc, chunkSize, completedTables, initialEntryCount } = opts;
	const completedSet = completedTables ?? new Set<string>();

	// Count tables and migrations for header
	const tableKeys = new Set<string>();
	const cvBounds = buildAllColumnVersionsScanBounds();
	for await (const entry of ctx.kv.iterate(cvBounds)) {
		const parsed = parseColumnVersionKey(entry.key);
		if (parsed) tableKeys.add(`${parsed.schema}.${parsed.table}`);
	}

	let migrationCount = 0;
	const smBounds = buildAllSchemaMigrationsScanBounds();
	for await (const _entry of ctx.kv.iterate(smBounds)) {
		migrationCount++;
	}

	// Yield header
	const header: SnapshotHeaderChunk = {
		type: 'header',
		siteId,
		hlc,
		tableCount: tableKeys.size,
		migrationCount,
		snapshotId,
	};
	yield header;

	// Stream each table, skipping completed ones
	let totalEntries = initialEntryCount ?? 0;
	for (const tableKey of tableKeys) {
		if (completedSet.has(tableKey)) continue;

		const [schema, table] = tableKey.split('.');
		const tableCvBounds = buildTableColumnVersionScanBounds(schema, table);

		// Yield table start (entry count filled in at table-end)
		const tableStart: SnapshotTableStartChunk = {
			type: 'table-start',
			schema,
			table,
			estimatedEntries: 0,
		};
		yield tableStart;

		// Stream column versions in chunks (single pass per table)
		let entries: Array<[string, HLC, SqlValue]> = [];
		let entriesWritten = 0;

		for await (const entry of ctx.kv.iterate(tableCvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			const versionKey = `${encodePK(parsed.pk)}:${parsed.column}`;
			entries.push([versionKey, cv.hlc, cv.value]);
			entriesWritten++;

			if (entries.length >= chunkSize) {
				const chunk: SnapshotColumnVersionsChunk = {
					type: 'column-versions',
					schema,
					table,
					entries,
				};
				yield chunk;
				entries = [];
			}
		}

		// Yield remaining entries
		if (entries.length > 0) {
			const chunk: SnapshotColumnVersionsChunk = {
				type: 'column-versions',
				schema,
				table,
				entries,
			};
			yield chunk;
		}

		// Yield table end
		const tableEnd: SnapshotTableEndChunk = {
			type: 'table-end',
			schema,
			table,
			entriesWritten,
		};
		yield tableEnd;

		totalEntries += entriesWritten;
	}

	// Stream schema migrations
	for await (const entry of ctx.kv.iterate(smBounds)) {
		const parsed = parseSchemaMigrationKey(entry.key);
		if (!parsed) continue;

		const migration = deserializeMigration(entry.value);
		const migrationChunk: SnapshotSchemaMigrationChunk = {
			type: 'schema-migration',
			migration: {
				type: migration.type,
				schema: parsed.schema,
				table: parsed.table,
				ddl: migration.ddl,
				hlc: migration.hlc,
				schemaVersion: migration.schemaVersion,
			},
		};
		yield migrationChunk;
	}

	// Yield footer
	const footer: SnapshotFooterChunk = {
		type: 'footer',
		snapshotId,
		totalTables: tableKeys.size,
		totalEntries,
		totalMigrations: migrationCount,
	};
	yield footer;
}

/**
 * Stream a snapshot as chunks for memory-efficient transfer.
 */
export async function* getSnapshotStream(
	ctx: SyncContext,
	chunkSize: number = DEFAULT_SNAPSHOT_CHUNK_SIZE,
): AsyncIterable<SnapshotChunk> {
	yield* streamSnapshotChunks(ctx, {
		snapshotId: crypto.randomUUID(),
		siteId: ctx.getSiteId(),
		hlc: ctx.getCurrentHLC(),
		chunkSize,
	});
}

/**
 * Resume a snapshot transfer from a checkpoint.
 */
export async function* resumeSnapshotStream(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): AsyncIterable<SnapshotChunk> {
	yield* streamSnapshotChunks(ctx, {
		snapshotId: checkpoint.snapshotId,
		siteId: checkpoint.siteId,
		hlc: checkpoint.hlc,
		chunkSize: DEFAULT_SNAPSHOT_CHUNK_SIZE,
		completedTables: new Set(checkpoint.completedTables),
		initialEntryCount: checkpoint.entriesProcessed,
	});
}

// ============================================================================
// Snapshot Application
// ============================================================================

/**
 * Parse the accumulated `schema.table` completed-table keys into the
 * `{ schema, table }` records the `bootstrapFinalize` coarse watch notification
 * consumes. Mirrors the `tableKey.split('.')` convention used throughout this
 * module.
 */
function parseBootstrapTables(
	completedTables: ReadonlyArray<string>,
): Array<{ schema: string; table: string }> {
	return completedTables.map((key) => {
		const [schema, table] = key.split('.');
		return { schema, table };
	});
}

/**
 * Clear existing CRDT metadata (column versions, tombstones, change log) ahead
 * of applying a snapshot.
 *
 * `preserveTables` names `schema.table` keys whose metadata must survive — on a
 * resumed transfer the sender skips already-completed tables and never re-emits
 * their metadata, so blanket-clearing would wipe state that is never rewritten.
 * With an empty `preserveTables` this deletes everything, identical to a fresh
 * full apply.
 */
async function clearExistingMetadata(
	ctx: SyncContext,
	preserveTables: ReadonlySet<string>,
): Promise<void> {
	const clearBatch = ctx.kv.batch();

	for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) {
		const parsed = parseColumnVersionKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
		const parsed = parseTombstoneKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds())) {
		const parsed = parseChangeLogKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}

	await clearBatch.write();
}

/**
 * Apply a streamed snapshot, processing chunks as they arrive.
 */
export async function applySnapshotStream(
	ctx: SyncContext,
	chunks: AsyncIterable<SnapshotChunk>,
	onProgress?: (progress: SnapshotProgress) => void,
): Promise<void> {
	let snapshotId: string | undefined;
	let snapshotHLC: HLC | undefined;
	let totalTables = 0;
	let totalEntries = 0;
	let tablesProcessed = 0;
	let entriesProcessed = 0;
	let currentTable: string | undefined;
	const completedTables: string[] = [];

	// Pending data to apply to store (batched for efficiency)
	let pendingDataChanges: DataChangeToApply[] = [];
	let pendingSchemaChanges: SchemaChangeToApply[] = [];
	const DATA_FLUSH_SIZE = 100;

	const flushDataToStore = async (): Promise<void> => {
		if (ctx.applyToStore && (pendingDataChanges.length > 0 || pendingSchemaChanges.length > 0)) {
			// A streamed snapshot is a known-complete wholesale load: each flush is a
			// bootstrap flush (the adapter skips the engine seam — no per-flush MV
			// maintenance, no per-row watch capture), converged once by the footer's
			// `bootstrapFinalize` below.
			const result = await ctx.applyToStore(pendingDataChanges, pendingSchemaChanges, { remote: true, bootstrap: true });
			// A per-change storage failure aborts the stream mid-flight, before the
			// footer emits `status: 'synced'` / clears the checkpoint — so the
			// checkpoint stays in place and the transfer resumes/retries.
			throwIfApplyErrors(ctx, result);
			pendingDataChanges = [];
			pendingSchemaChanges = [];
		}
	};

	// Process chunks
	let batch = ctx.kv.batch();
	let batchSize = 0;
	const BATCH_FLUSH_SIZE = 1000;

	let currentTableSchema: string | undefined;
	let currentTableName: string | undefined;
	const rowColumns = new Map<string, Record<string, SqlValue>>();

	for await (const chunk of chunks) {
		switch (chunk.type) {
			case 'header': {
				snapshotId = chunk.snapshotId;
				snapshotHLC = chunk.hlc;
				totalTables = chunk.tableCount;

				// On a resumed transfer the sender skips tables it already streamed and
				// never re-emits their metadata. Look up the persisted checkpoint (saved
				// under this snapshotId during the prior pass) and preserve those completed
				// tables through the up-front clear; otherwise their column-version /
				// change-log state would be wiped and never rewritten. Seed the local
				// counters from the checkpoint so mid-stream checkpoint saves stay
				// monotonic and progress reporting reflects the full transfer.
				const checkpoint = snapshotId ? await getSnapshotCheckpoint(ctx, snapshotId) : undefined;
				if (checkpoint) {
					completedTables.push(...checkpoint.completedTables);
					tablesProcessed = checkpoint.completedTables.length;
					entriesProcessed = checkpoint.entriesProcessed;
				}
				await clearExistingMetadata(ctx, new Set(completedTables));
				break;
			}

			case 'table-start':
				currentTable = `${chunk.schema}.${chunk.table}`;
				currentTableSchema = chunk.schema;
				currentTableName = chunk.table;
				totalEntries += chunk.estimatedEntries;
				rowColumns.clear();
				break;

			case 'column-versions':
				for (const [versionKey, hlc, value] of chunk.entries) {
					const lastColon = versionKey.lastIndexOf(':');
					if (lastColon === -1) continue;

					const rowKey = versionKey.slice(0, lastColon);
					const column = versionKey.slice(lastColon + 1);
					const pk = JSON.parse(rowKey) as SqlValue[];

					// Track column for data application
					if (!rowColumns.has(rowKey)) {
						rowColumns.set(rowKey, {});
					}
					rowColumns.get(rowKey)![column] = value;

					// Write CRDT metadata
					ctx.columnVersions.setColumnVersionBatch(
						batch,
						chunk.schema,
						chunk.table,
						pk,
						column,
						{ hlc, value },
					);

					ctx.changeLog.recordColumnChangeBatch(
						batch,
						hlc,
						chunk.schema,
						chunk.table,
						pk,
						column,
					);

					batchSize++;
					entriesProcessed++;

					if (batchSize >= BATCH_FLUSH_SIZE) {
						await batch.write();
						batch = ctx.kv.batch();
						batchSize = 0;

						// Save checkpoint
						if (snapshotId && snapshotHLC) {
							await saveSnapshotCheckpoint(ctx, {
								snapshotId,
								siteId: ctx.getSiteId(),
								hlc: snapshotHLC,
								lastTableIndex: tablesProcessed,
								lastEntryIndex: entriesProcessed,
								completedTables: [...completedTables],
								entriesProcessed,
								createdAt: Date.now(),
							});
						}
					}
				}

				if (onProgress && snapshotId) {
					onProgress({
						snapshotId,
						tablesProcessed,
						totalTables,
						entriesProcessed,
						totalEntries,
						currentTable,
					});
				}
				break;

			case 'table-end':
				// Flush accumulated rows to store
				if (currentTableSchema && currentTableName) {
					for (const [rowKey, columns] of rowColumns) {
						const pk = JSON.parse(rowKey) as SqlValue[];
						pendingDataChanges.push({
							type: 'update',
							schema: currentTableSchema,
							table: currentTableName,
							pk,
							columns,
						});

						if (pendingDataChanges.length >= DATA_FLUSH_SIZE) {
							await flushDataToStore();
						}
					}
					rowColumns.clear();
				}

				tablesProcessed++;
				if (currentTable) {
					completedTables.push(currentTable);
				}
				break;

			case 'schema-migration': {
				const migration = chunk.migration;
				pendingSchemaChanges.push({
					type: migration.type,
					schema: migration.schema,
					table: migration.table,
					ddl: migration.ddl,
				});

				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
				break;
			}

			case 'footer':
				// Flush remaining data to store
				await flushDataToStore();

				// Flush remaining metadata batch
				if (batchSize > 0) {
					await batch.write();
				}

				// Update HLC
				if (snapshotHLC) {
					ctx.hlcManager.receive(snapshotHLC);
					await persistHLCState(ctx);
				}

				// Converge the bootstrap: the flushes deferred MV maintenance and watch
				// capture, so converge every MV once and coarse-notify each bootstrapped
				// table's watchers. Issued BEFORE clearing the checkpoint — a finalize
				// failure leaves the checkpoint in place so the transfer retries (storage
				// rows are already applied, so the retry's finalize rebuilds cleanly).
				// `completedTables` is the full set even on a resumed transfer (seeded
				// from the checkpoint in the `header` case).
				if (ctx.applyToStore) {
					await ctx.applyToStore([], [], {
						remote: true,
						bootstrapFinalize: true,
						bootstrapTables: parseBootstrapTables(completedTables),
					});
				}

				// Clear checkpoint
				if (snapshotId) {
					await clearSnapshotCheckpoint(ctx, snapshotId);
				}

				// Emit sync state change
				if (snapshotHLC) {
					ctx.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshotHLC });
				}
				break;
		}
	}
}

// ============================================================================
// Checkpoint Management
// ============================================================================

/**
 * Retrieve a saved checkpoint for an in-progress snapshot.
 */
export async function getSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<SnapshotCheckpoint | undefined> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
	const data = await ctx.kv.get(key);
	if (!data) return undefined;

	const json = new TextDecoder().decode(data);
	const obj = JSON.parse(json);

	return {
		...obj,
		hlc: {
			wallTime: BigInt(obj.hlc.wallTime),
			counter: obj.hlc.counter,
			siteId: new Uint8Array(obj.hlc.siteId),
			opSeq: obj.hlc.opSeq ?? 0,
		},
		siteId: new Uint8Array(obj.siteId),
	};
}

/**
 * Save a checkpoint during a streaming snapshot apply.
 */
async function saveSnapshotCheckpoint(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): Promise<void> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${checkpoint.snapshotId}`);
	const json = JSON.stringify({
		...checkpoint,
		hlc: {
			wallTime: checkpoint.hlc.wallTime.toString(),
			counter: checkpoint.hlc.counter,
			siteId: Array.from(checkpoint.hlc.siteId),
			opSeq: checkpoint.hlc.opSeq,
		},
		siteId: Array.from(checkpoint.siteId),
	});
	await ctx.kv.put(key, new TextEncoder().encode(json));
}

/**
 * Clear checkpoint after a snapshot completes successfully.
 */
async function clearSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<void> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
	await ctx.kv.delete(key);
}
