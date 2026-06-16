/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 * Delegates to focused sub-modules for snapshot, streaming, and change application.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import type {
	SqlValue,
	Row,
	TransactionCommitBatch,
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
} from '@quereus/quereus';
import { QuereusError, StatusCode } from '@quereus/quereus';
import type { GetTableSchemaCallback, TransactionCommitSource } from '../create-sync-module.js';
import { HLCManager, type HLC, compareHLC, createHLC, deterministicTxnId, MAX_OPSEQ } from '../clock/hlc.js';
import {
	generateSiteId,
	type SiteId,
	SITE_ID_KEY,
	serializeSiteIdentity,
	deserializeSiteIdentity,
	siteIdEquals,
} from '../clock/site.js';
import { ColumnVersionStore, type ColumnVersion, deserializeColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore, deserializeTombstone } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { SchemaMigrationStore, deserializeMigration } from '../metadata/schema-migration.js';
import { ChangeLogStore } from '../metadata/change-log.js';
import {
	SYNC_KEY_PREFIX,
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	parseSchemaMigrationKey,
} from '../metadata/keys.js';
import type { SyncManager, SnapshotCheckpoint } from './manager.js';
import type {
	SyncConfig,
	ChangeSet,
	Change,
	ColumnChange,
	RowDeletion,
	ApplyResult,
	Snapshot,
	SchemaMigration,
	SchemaMigrationType,
	SnapshotChunk,
	SnapshotProgress,
	ApplyToStoreCallback,
} from './protocol.js';
import { SyncEventEmitterImpl } from './events.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCStateBatch, toError } from './sync-context.js';
import { applyChanges as applyChangesImpl } from './change-applicator.js';
import { buildTransactionChangeSets } from './change-grouping.js';
import { getSnapshot as getSnapshotImpl, applySnapshot as applySnapshotImpl } from './snapshot.js';
import {
	getSnapshotStream as getSnapshotStreamImpl,
	applySnapshotStream as applySnapshotStreamImpl,
	getSnapshotCheckpoint as getSnapshotCheckpointImpl,
	resumeSnapshotStream as resumeSnapshotStreamImpl,
} from './snapshot-stream.js';

/**
 * Guard a transaction's running `opSeq` against the uint32 bound. `opSeq` is
 * serialized as a big-endian uint32 in the HLC comparison key, so a fact count
 * exceeding {@link MAX_OPSEQ} would silently wrap and corrupt ordering — throw
 * instead. Practically unreachable (4 billion facts in one transaction); the
 * write side telemeters the throw via an error sync-state event.
 */
export function assertOpSeqInRange(opSeq: number): void {
	if (opSeq > MAX_OPSEQ) {
		throw new QuereusError(
			`Transaction exceeds ${MAX_OPSEQ + 1} facts; opSeq exhausted`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Map an engine schema-change event `(objectType, type)` to the sync
 * {@link SchemaMigrationType} it records, or `undefined` when the combination is
 * not tracked for replication (e.g. column-level or view/trigger objects, or an
 * `alter` on an index). A `'table' alter` is recorded as `alter_column` — the
 * coarse "table definition changed" migration the schema-sync layer replays.
 */
function mapSchemaMigrationType(
	objectType: DatabaseSchemaChangeEvent['objectType'],
	type: DatabaseSchemaChangeEvent['type'],
): SchemaMigrationType | undefined {
	if (objectType === 'table') {
		switch (type) {
			case 'create': return 'create_table';
			case 'drop': return 'drop_table';
			case 'alter': return 'alter_column';
		}
	} else if (objectType === 'index') {
		switch (type) {
			case 'create': return 'add_index';
			case 'drop': return 'drop_index';
		}
	}
	return undefined;
}

/**
 * Implementation of SyncManager.
 *
 * Acts as a coordinator/facade that delegates snapshot, streaming,
 * and change application to focused sub-modules.
 */
export class SyncManagerImpl implements SyncManager, SyncContext {
	readonly kv: KVStore;
	readonly config: SyncConfig;
	readonly hlcManager: HLCManager;
	readonly columnVersions: ColumnVersionStore;
	readonly tombstones: TombstoneStore;
	private readonly peerStates: PeerStateStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;
	private readonly getTableSchema?: GetTableSchemaCallback;

	private constructor(
		kv: KVStore,
		config: SyncConfig,
		hlcManager: HLCManager,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback
	) {
		this.kv = kv;
		this.config = config;
		this.hlcManager = hlcManager;
		this.syncEvents = syncEvents;
		this.applyToStore = applyToStore;
		this.getTableSchema = getTableSchema;
		this.columnVersions = new ColumnVersionStore(kv);
		this.tombstones = new TombstoneStore(kv, config.tombstoneTTL);
		this.peerStates = new PeerStateStore(kv);
		this.changeLog = new ChangeLogStore(kv);
		this.schemaMigrations = new SchemaMigrationStore(kv);
	}

	/**
	 * Create a new SyncManager, initializing or loading site identity.
	 *
	 * @param kv - KV store for sync metadata
	 * @param transactionSource - Engine transaction-commit source for local change
	 *   capture (a `Database`, or any `onTransactionCommit` emitter). When provided,
	 *   sync subscribes to `onTransactionCommit` and records CRDT metadata for each
	 *   committed local transaction — one HLC per transaction. Pass `undefined` for a
	 *   relay-only deployment (e.g. a coordinator) that captures no local DML.
	 * @param config - Sync configuration
	 * @param syncEvents - Sync event emitter for UI integration
	 * @param applyToStore - Optional callback for applying remote changes to the store
	 * @param getTableSchema - Optional callback for getting table schema by name
	 */
	static async create(
		kv: KVStore,
		transactionSource: TransactionCommitSource | undefined,
		config: SyncConfig,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback
	): Promise<SyncManagerImpl> {
		// Load or create site identity
		const siteIdKey = new TextEncoder().encode(SITE_ID_KEY);
		let siteId: SiteId;

		const existingIdentity = await kv.get(siteIdKey);
		if (existingIdentity) {
			const identity = deserializeSiteIdentity(existingIdentity);
			siteId = identity.siteId;
		} else if (config.siteId) {
			siteId = config.siteId;
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		} else {
			siteId = generateSiteId();
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		}

		// Load HLC state
		const hlcKey = SYNC_KEY_PREFIX.HLC_STATE;
		const hlcData = await kv.get(hlcKey);
		let hlcState: { wallTime: bigint; counter: number } | undefined;
		if (hlcData) {
			const view = new DataView(hlcData.buffer, hlcData.byteOffset, hlcData.byteLength);
			hlcState = {
				wallTime: view.getBigUint64(0, false),
				counter: view.getUint16(8, false),
			};
		}

		const hlcManager = new HLCManager(siteId, hlcState);
		const manager = new SyncManagerImpl(kv, config, hlcManager, syncEvents, applyToStore, getTableSchema);

		// Capture local changes at the engine transaction boundary: one grouped
		// `onTransactionCommit` batch ⇒ one transaction ⇒ one HLC. The store's
		// per-table emitter is below the transaction boundary and cannot group a
		// multi-table transaction (docs/sync.md § Transaction-Based Change Grouping),
		// so we subscribe here, not there. Omitted for relay-only deployments.
		transactionSource?.onTransactionCommit((batch) => {
			void manager.handleTransactionCommit(batch);
		});

		return manager;
	}

	// ============================================================================
	// Accessors
	// ============================================================================

	getSiteId(): SiteId {
		return this.hlcManager.getSiteId();
	}

	getCurrentHLC(): HLC {
		return this.hlcManager.now();
	}

	// ============================================================================
	// Local change capture (engine transaction boundary)
	// ============================================================================

	/**
	 * Record CRDT metadata for one committed local transaction.
	 *
	 * Driven by the engine's `onTransactionCommit` group — the authoritative
	 * "one transaction = one HLC" boundary. The clock is ticked exactly **once**;
	 * every fact of the transaction shares that base `(wallTime, counter, siteId)`
	 * and differs only in `opSeq` (a contiguous, 0-based sub-order). DDL is recorded
	 * before DML so migrations sort below the same transaction's data facts
	 * (docs/sync.md § DDL Application Order). All metadata for the transaction —
	 * schema migrations, column versions, tombstones, change-log entries, and the
	 * HLC clock state — lands in a single KV batch.
	 */
	private async handleTransactionCommit(batch: TransactionCommitBatch): Promise<void> {
		try {
			// Capture only LOCAL facts. An all-remote group is a pure sync-apply echo:
			// its metadata was already recorded by the apply path. A mixed group
			// (local + remote in one transaction — unusual) records only its local
			// facts; opSeq is assigned only to recorded facts so they stay contiguous.
			const localSchema = batch.schemaEvents.filter(e => !e.remote);
			const localData = batch.dataEvents.filter(e => !e.remote);
			if (localSchema.length === 0 && localData.length === 0) return;

			// ONE tick per committed transaction. tick() returns opSeq 0; the closure
			// below stamps each successive fact with the next opSeq off the same base.
			const base = this.hlcManager.tick();
			const transactionId = deterministicTxnId(base);

			let opSeq = 0;
			const nextHlc = (): HLC => {
				// Throw (telemetered via the catch below) rather than wrap the uint32.
				assertOpSeqInRange(opSeq);
				return createHLC(base.wallTime, base.counter, base.siteId, opSeq++);
			};

			const kvBatch = this.kv.batch();
			const changes: Change[] = [];

			// DDL before DML: migrations take the lowest opSeqs.
			const versionCounters = new Map<string, number>();
			for (const event of localSchema) {
				await this.recordSchemaMigration(kvBatch, event, nextHlc, versionCounters);
			}

			for (const event of localData) {
				await this.recordDataEvent(kvBatch, event, nextHlc, changes);
			}

			// Persist HLC clock state (wallTime/counter only — opSeq is never persisted).
			persistHLCStateBatch(this, kvBatch);

			await kvBatch.write();

			this.syncEvents.emitLocalChange({
				transactionId,
				changes,
				pendingSync: true,
			});
		} catch (error) {
			console.error('[Sync] Error handling transaction commit:', error);
			this.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
		}
	}

	/**
	 * Record one local schema-change event as a migration. Allocates an `opSeq`
	 * (via `nextHlc`) only when the event maps to a tracked migration, so
	 * unsupported object types consume no sub-order. `versionCounters` carries the
	 * running per-table schema version across this transaction's migrations.
	 */
	private async recordSchemaMigration(
		batch: WriteBatch,
		event: DatabaseSchemaChangeEvent,
		nextHlc: () => HLC,
		versionCounters: Map<string, number>,
	): Promise<void> {
		const migrationType = mapSchemaMigrationType(event.objectType, event.type);
		if (!migrationType) return;

		const { schemaName, objectName, ddl } = event;
		const counterKey = `${schemaName}.${objectName}`;
		let version = versionCounters.get(counterKey);
		if (version === undefined) {
			version = await this.schemaMigrations.getCurrentVersion(schemaName, objectName);
		}
		version += 1;
		versionCounters.set(counterKey, version);

		this.schemaMigrations.recordMigrationBatch(batch, schemaName, objectName, {
			type: migrationType,
			ddl: ddl || '',
			hlc: nextHlc(),
			schemaVersion: version,
		});
	}

	/**
	 * Record one local data-change event: a tombstone (delete) or the changed
	 * column versions (insert/update). Each recorded fact consumes one `opSeq`.
	 */
	private async recordDataEvent(
		batch: WriteBatch,
		event: DatabaseDataChangeEvent,
		nextHlc: () => HLC,
		changes: Change[],
	): Promise<void> {
		const { schemaName, tableName, type, oldRow, newRow } = event;
		const pk = event.key;
		if (!pk) {
			console.warn(`[Sync] Missing primary key for ${schemaName}.${tableName} ${type} event — change not tracked`);
			return;
		}

		if (type === 'delete') {
			const hlc = nextHlc();
			this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, hlc);
			this.changeLog.recordDeletionBatch(batch, hlc, schemaName, tableName, pk);
			await this.columnVersions.deleteRowVersions(schemaName, tableName, pk);

			const change: RowDeletion = {
				type: 'delete',
				schema: schemaName,
				table: tableName,
				pk,
				hlc,
			};
			changes.push(change);
		} else if (newRow) {
			await this.recordColumnVersions(batch, schemaName, tableName, pk, oldRow, newRow, nextHlc, changes);
		}
	}

	private async recordColumnVersions(
		batch: WriteBatch,
		schemaName: string,
		tableName: string,
		pk: SqlValue[],
		oldRow: Row | undefined,
		newRow: Row,
		nextHlc: () => HLC,
		changes: Change[],
	): Promise<void> {
		const tableSchema = this.getTableSchema?.(schemaName, tableName);
		const columnNames = tableSchema?.columns?.map(c => c.name);

		if (!tableSchema && this.getTableSchema) {
			console.warn(`[Sync] No table schema found for ${schemaName}.${tableName} - using fallback column names`);
		}

		for (let i = 0; i < newRow.length; i++) {
			const oldValue = oldRow?.[i];
			const newValue = newRow[i];

			if (!oldRow || oldValue !== newValue) {
				const column = columnNames?.[i] ?? `col_${i}`;

				const oldVersion = await this.columnVersions.getColumnVersion(
					schemaName, tableName, pk, column
				);

				if (oldVersion) {
					this.changeLog.deleteEntryBatch(
						batch,
						oldVersion.hlc,
						'column',
						schemaName,
						tableName,
						pk,
						column
					);
				}

				const hlc = nextHlc();
				const version: ColumnVersion = { hlc, value: newValue };
				this.columnVersions.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version);
				this.changeLog.recordColumnChangeBatch(batch, hlc, schemaName, tableName, pk, column);

				const change: ColumnChange = {
					type: 'column',
					schema: schemaName,
					table: tableName,
					pk,
					column,
					value: newValue,
					hlc,
				};
				changes.push(change);
			}
		}
	}

	// ============================================================================
	// Delta Sync API
	// ============================================================================

	/**
	 * Extract changes for a peer as **one {@link ChangeSet} per source
	 * transaction** (grouped by HLC identity `(wallTime, counter, siteId)`),
	 * bounded at transaction granularity by `config.batchSize`. A transaction is
	 * never split across ChangeSets and two transactions are never merged, so a
	 * consumer that advances `lastSyncHLC = ChangeSet.hlc` always lands on a real
	 * commit boundary (docs/sync.md § Transaction-Based Change Grouping → Read side).
	 */
	async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
		const changes: Change[] = sinceHLC
			? await this.collectChangesSince(peerSiteId, sinceHLC)
			: await this.collectAllChanges(peerSiteId);

		const schemaMigrations = await this.collectSchemaMigrations(peerSiteId, sinceHLC);

		return buildTransactionChangeSets(
			changes,
			schemaMigrations,
			this.config.batchSize,
			(transactionId, changeCount) => {
				// Oversized transactions are returned whole (never split); telemeter
				// rather than silently chunk so the bound breach is observable.
				console.warn(
					`[Sync] Oversized transaction ${transactionId}: ${changeCount} changes exceed batchSize ${this.config.batchSize}; returned as one ChangeSet`,
				);
			},
		);
	}

	/** Delta extraction: facts after `sinceHLC`, in change-log (4-tuple) order. */
	private async collectChangesSince(peerSiteId: SiteId, sinceHLC: HLC): Promise<Change[]> {
		const changes: Change[] = [];
		for await (const logEntry of this.changeLog.getChangesSince(sinceHLC)) {
			// A transaction is wholly one site's, so skipping the peer's own facts
			// filters whole transactions cleanly (no half-empty ChangeSet).
			if (siteIdEquals(logEntry.hlc.siteId, peerSiteId)) continue;

			if (logEntry.entryType === 'column') {
				const cv = await this.columnVersions.getColumnVersion(
					logEntry.schema,
					logEntry.table,
					logEntry.pk,
					logEntry.column!
				);
				if (!cv) continue;

				const columnChange: ColumnChange = {
					type: 'column',
					schema: logEntry.schema,
					table: logEntry.table,
					pk: logEntry.pk,
					column: logEntry.column!,
					value: cv.value,
					hlc: cv.hlc,
				};
				changes.push(columnChange);
			} else {
				const tombstone = await this.tombstones.getTombstone(
					logEntry.schema,
					logEntry.table,
					logEntry.pk
				);
				if (!tombstone) continue;

				const deletion: RowDeletion = {
					type: 'delete',
					schema: logEntry.schema,
					table: logEntry.table,
					pk: logEntry.pk,
					hlc: tombstone.hlc,
				};
				changes.push(deletion);
			}
		}
		return changes;
	}

	/**
	 * Full extraction (initial sync / delta-from-zero): every column version and
	 * tombstone not originating from the peer. Ordering is owned by
	 * {@link buildTransactionChangeSets}, so no pre-sort is needed here.
	 */
	private async collectAllChanges(peerSiteId: SiteId): Promise<Change[]> {
		const changes: Change[] = [];

		const cvBounds = buildAllColumnVersionsScanBounds();
		for await (const entry of this.kv.iterate(cvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			if (siteIdEquals(cv.hlc.siteId, peerSiteId)) continue;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: parsed.schema,
				table: parsed.table,
				pk: parsed.pk,
				column: parsed.column,
				value: cv.value,
				hlc: cv.hlc,
			};
			changes.push(columnChange);
		}

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const parsed = parseTombstoneKey(entry.key);
			if (!parsed) continue;

			const tombstone = deserializeTombstone(entry.value);
			if (siteIdEquals(tombstone.hlc.siteId, peerSiteId)) continue;

			const deletion: RowDeletion = {
				type: 'delete',
				schema: parsed.schema,
				table: parsed.table,
				pk: parsed.pk,
				hlc: tombstone.hlc,
			};
			changes.push(deletion);
		}

		return changes;
	}

	/**
	 * Collect schema migrations after `sinceHLC` not originating from the peer.
	 * Each migration shares its transaction's base HLC, so the grouping step
	 * rejoins it with that transaction's data facts (or forms a DDL-only ChangeSet).
	 */
	private async collectSchemaMigrations(
		peerSiteId: SiteId,
		sinceHLC?: HLC,
	): Promise<SchemaMigration[]> {
		const schemaMigrations: SchemaMigration[] = [];
		const smBounds = buildAllSchemaMigrationsScanBounds();
		for await (const entry of this.kv.iterate(smBounds)) {
			const parsed = parseSchemaMigrationKey(entry.key);
			if (!parsed) continue;

			const migration = deserializeMigration(entry.value);

			if (sinceHLC && compareHLC(migration.hlc, sinceHLC) <= 0) continue;
			if (siteIdEquals(migration.hlc.siteId, peerSiteId)) continue;

			schemaMigrations.push({
				type: migration.type,
				schema: parsed.schema,
				table: parsed.table,
				ddl: migration.ddl,
				hlc: migration.hlc,
				schemaVersion: migration.schemaVersion,
			});
		}
		return schemaMigrations;
	}

	// ============================================================================
	// Delegated: Change Application
	// ============================================================================

	async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
		return applyChangesImpl(this, changes);
	}

	async canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean> {
		const peerState = await this.peerStates.getPeerState(peerSiteId);
		if (!peerState) {
			return false;
		}

		// Check if tombstone TTL covers the requested time range
		const now = Date.now();
		const sinceTime = Number(sinceHLC.wallTime);
		if (now - sinceTime > this.config.tombstoneTTL) {
			return false;
		}

		return true;
	}

	// ============================================================================
	// Delegated: Non-Streaming Snapshots
	// ============================================================================

	async getSnapshot(): Promise<Snapshot> {
		return getSnapshotImpl(this);
	}

	async applySnapshot(snapshot: Snapshot): Promise<void> {
		return applySnapshotImpl(this, snapshot);
	}

	// ============================================================================
	// Peer State & Maintenance
	// ============================================================================

	async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
		await this.peerStates.setPeerState(peerSiteId, hlc);
	}

	async getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined> {
		const state = await this.peerStates.getPeerState(peerSiteId);
		return state?.lastSyncHLC;
	}

	async pruneTombstones(): Promise<number> {
		const now = Date.now();
		let count = 0;
		const batch = this.kv.batch();

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const tombstone = deserializeTombstone(entry.value);

			if (now - tombstone.createdAt > this.config.tombstoneTTL) {
				batch.delete(entry.key);
				count++;
			}
		}

		await batch.write();
		return count;
	}

	getEventEmitter(): SyncEventEmitterImpl {
		return this.syncEvents;
	}

	// ============================================================================
	// Delegated: Streaming Snapshot API
	// ============================================================================

	async *getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk> {
		yield* getSnapshotStreamImpl(this, chunkSize);
	}

	async applySnapshotStream(
		chunks: AsyncIterable<SnapshotChunk>,
		onProgress?: (progress: SnapshotProgress) => void
	): Promise<void> {
		return applySnapshotStreamImpl(this, chunks, onProgress);
	}

	async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
		return getSnapshotCheckpointImpl(this, snapshotId);
	}

	async *resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {
		yield* resumeSnapshotStreamImpl(this, checkpoint);
	}
}
