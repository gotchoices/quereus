/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 * Delegates to focused sub-modules for snapshot, streaming, and change application.
 */

import { BUILTIN_KEY_NORMALIZER_RESOLVER, type KVStore, type WriteBatch } from '@quereus/store';
import type {
	SqlValue,
	Row,
	Database,
	KeyNormalizerResolver,
	LensDeploymentSnapshot,
	TableSchema,
	TransactionCommitBatch,
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
} from '@quereus/quereus';
import { QuereusError, StatusCode, SYNC_EVICT_TAG, sqlValueIdentical } from '@quereus/quereus';
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
import { ColumnVersionStore, type ColumnVersionData, deserializeColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore, deserializeTombstone } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { DeltaFloorStore } from '../metadata/delta-floor.js';
import { SchemaMigrationStore } from '../metadata/schema-migration.js';
import { ChangeLogStore, type ChangeLogEntry } from '../metadata/change-log.js';
import { filingPosition } from '../metadata/filing-position.js';
import { QuarantineStore } from '../metadata/quarantine.js';
import {
	BasisLifecycleStore,
	classifyBasisLifecycle,
	basisLifecycleRecordChanged,
	splitRelKey,
	parseEvictPolicyTag,
	isEvictable,
	quietSince,
	type BasisTableLifecycleRecord,
	type EvictPolicy,
} from '../metadata/basis-lifecycle.js';
import type { BasisTableLifecycleEvent } from './events.js';
import {
	SYNC_KEY_PREFIX,
	SYNC_METADATA_FORMAT_VERSION,
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	joinKeyParts,
	type PkKeying,
} from '../metadata/keys.js';
import { BASELINE_SCHEMA_VERSION, migrationObjectKind } from './protocol.js';
import { createPkKeyingResolver, resolvePkKeying, type PkKeyingResolver } from '../metadata/pk-identity.js';
import { TableIdentityStore, withIdentityRecovery } from '../metadata/table-identity.js';
import type { AdoptedRows, SyncManager, SnapshotCheckpoint } from './manager.js';
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
	DropLocalTableCallback,
	UnknownTableDisposition,
} from './protocol.js';
import { SyncEventEmitterImpl } from './events.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, persistHLCStateBatch, toError, deleteRowVersionsAndLogEntries } from './sync-context.js';
import { StagedTransactionMetadata } from './staged-transaction-metadata.js';
import { applyChanges as applyChangesImpl, drainHeldChanges as drainHeldChangesImpl, drainReappearedTables } from './change-applicator.js';
import { buildTransactionChangeSets, filedAtOrigin, filingGroupKey, type FiledChange } from './change-grouping.js';
import { alterPrimaryKeyColumns } from './migration-ddl.js';
import { rekeyTableBookkeeping, reportRekeyOutcome, type RekeyCounts } from './rekey-on-pk-change.js';
import { getSnapshot as getSnapshotImpl, applySnapshot as applySnapshotImpl } from './snapshot.js';
import {
	getSnapshotStream as getSnapshotStreamImpl,
	applySnapshotStream as applySnapshotStreamImpl,
	resumeSnapshotStream as resumeSnapshotStreamImpl,
} from './snapshot-stream.js';
import {
	getSnapshotCheckpoint as getSnapshotCheckpointImpl,
	listSnapshotCheckpoints as listSnapshotCheckpointsImpl,
	clearSnapshotCheckpoint as clearSnapshotCheckpointImpl,
} from './snapshot-checkpoint.js';
import {
	adoptUnrecordedRows as adoptUnrecordedRowsImpl,
	announcementFor,
	findTablesWithUnrecordedRows as findTablesWithUnrecordedRowsImpl,
	receiversCanWrite,
} from './unrecorded-rows.js';

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
 * Map an engine schema-change event to the sync {@link SchemaMigrationType} it
 * records, or `undefined` when the combination is not tracked for replication
 * (e.g. an `alter` on an index). Takes the whole event rather than
 * `(objectType, type)` because a rename is only distinguishable by `oldObjectName`,
 * which exactly the three RENAME TO emit sites set — `StoreModuleRename.renameTable`,
 * the memory module's `renameTable`, and the engine's own `runRenameTable` tail (for a
 * module with no emitter of its own). All three put the NEW name in `objectName`.
 *
 * Every `'table' alter` and EVERY column arm is recorded as `alter_column` — the coarse
 * "table definition changed" migration the schema-sync layer replays by parsing the
 * carried `ddl` and deciding per arm (`store-adapter.ts` § `decideAlterTable`). That
 * includes `drop column`, which arrives as `drop`/`column`: it is a table-definition
 * change, NOT a `drop_table`.
 *
 * The `objectType` dispatch is exhaustive (`never` fall-through) on purpose: a silently
 * unmapped object type disables replication for it without a word, which is how
 * column-shaped ALTER events went unrecorded before. A new object type must fail the
 * build here and be decided deliberately. Exhaustiveness is over `objectType` only —
 * an untracked `(objectType, type)` combination inside a branch still returns `undefined`.
 */
export function mapSchemaMigrationType(event: DatabaseSchemaChangeEvent): SchemaMigrationType | undefined {
	const { objectType, type } = event;
	switch (objectType) {
		case 'table': {
			if (type === 'create') return 'create_table';
			if (type === 'drop') return 'drop_table';
			// A rename is the only `'table' alter` distinguishable from the rest; everything
			// else that alters a table definition is the coarse `alter_column`.
			if (type === 'alter') return event.oldObjectName !== undefined ? 'rename_table' : 'alter_column';
			return undefined;
		}
		case 'column': {
			// Both `alter column` / `add column` / `rename column` (`alter`) and `drop column`
			// (`drop`) are table-definition changes replayed from the carried `ddl`.
			if (type === 'alter' || type === 'drop') return 'alter_column';
			return undefined;
		}
		case 'index': {
			if (type === 'create') return 'add_index';
			if (type === 'drop') return 'drop_index';
			return undefined;
		}
		default: {
			const _exhaustive: never = objectType;
			void _exhaustive;
			return undefined;
		}
	}
}

/** One table's uncaptured facts in a transaction, for the log line. */
interface SkippedTable {
	count: number;
	reason: 'dropped here' | 'outside the basis' | 'unwritable';
	/** `unwritable` only: the definition, so the warning can be issued once per schema object. */
	definition?: TableSchema;
}

/**
 * Whether `recordDataEvent` records anything for the event: a delete always files a
 * tombstone; an insert or update files a cell only where a value changed, by the same
 * by-value test `recordColumnVersions` applies. An update that changes nothing records
 * nothing and leaves an unrecorded row unrecorded, so it announces nothing either.
 */
function recordsAFact(event: DatabaseDataChangeEvent): boolean {
	if (!event.key) return false;
	if (event.type === 'delete') return true;
	const { oldRow, newRow } = event;
	if (!newRow) return false;
	return newRow.some((value, i) => cellChanged(oldRow, i, value));
}

/**
 * Whether a write changes cell `i`, by value: a blob or JSON value read back from a row
 * is a new object each time, and re-recording an untouched cell would overwrite a
 * peer's concurrent write to it. An insert (no `oldRow`) changes every cell.
 */
function cellChanged(oldRow: Row | undefined, i: number, value: SqlValue): boolean {
	return !oldRow || !sqlValueIdentical(oldRow[i], value);
}

/**
 * The name a table had before this transaction's own renames, which is the name whose
 * migrations storage holds, and whether the transaction created it under any name along
 * the way (then its own create is recorded and nothing needs announcing).
 */
function originOfName(
	localSchema: DatabaseSchemaChangeEvent[],
	schema: string,
	table: string,
): { name: string; createdHere: boolean } {
	const isTableEvent = (e: DatabaseSchemaChangeEvent, name: string): boolean =>
		e.objectType === 'table' && e.schemaName === schema && e.objectName === name;
	const visited = new Set<string>();
	let name = table;
	for (;;) {
		if (localSchema.some(e => e.type === 'create' && isTableEvent(e, name))) return { name, createdHere: true };
		const rename = localSchema.find(e => e.type === 'alter' && e.oldObjectName !== undefined && isTableEvent(e, name));
		if (!rename || visited.has(name)) return { name, createdHere: false };
		visited.add(name);
		name = rename.oldObjectName!;
	}
}

/**
 * The engine behind a transaction source, when it is one. `TransactionCommitSource` is
 * the narrow slice the capture subscribes to; the primary-key re-key pass also has to
 * READ the table (`rekey-on-pk-change.ts`), which only a full `Database` can do.
 * Structural rather than `instanceof`, so a second copy of the engine package in a
 * host bundle does not hide the database.
 */
function databaseOf(source: TransactionCommitSource | undefined): Database | undefined {
	const candidate = source as Partial<Database> | undefined;
	return typeof candidate?.eval === 'function' && typeof candidate.exec === 'function' ? (source as Database) : undefined;
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
	readonly deltaFloor: DeltaFloorStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly quarantine: QuarantineStore;
	readonly basisLifecycle: BasisLifecycleStore;
	readonly tableIdentity: TableIdentityStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;
	private readonly getTableSchema?: GetTableSchemaCallback;
	/** Reclaim-by-name callback for the eviction sweep; absent ⇒ sweep is a no-op. */
	private readonly dropLocalTable?: DropLocalTableCallback;
	/**
	 * Per-table pk-identity keying resolver (see `metadata/pk-identity.ts`),
	 * threaded into every metadata store so `cv:`/`tb:`/`cl:` keys file under the
	 * row's collation/transform-normalized identity. Raw keying when no
	 * `getTableSchema` oracle was wired (relay-only deployment).
	 */
	private readonly pkKeying: PkKeyingResolver;
	/** The collation resolver the keying is built with — re-used to derive a RETIRED key's keying. */
	private readonly keyNormalizerResolver: KeyNormalizerResolver;
	/** See {@link SyncContext.db}. */
	readonly db?: Database;

	// Tail-promise chain serializing commit recording. Each commit chains onto the
	// prior handler's completion so N+1's dedup reads see N's durable writes,
	// preserving the change-log ordering invariant (docs/sync-transactions.md § Transaction-Based
	// Change Grouping). Without this, two rapid commits interleave at the first
	// `await` and a stale change-log entry survives. Remote applies file their metadata
	// on the same chain (see onCommitChain): it is the one place a filing position is
	// both issued and written.
	private commitChain: Promise<void> = Promise.resolve();

	// Settles when every apply started so far has. See whenAppliesSettled.
	private appliesInFlight: Promise<void> = Promise.resolve();

	// Settles when every adoption started so far has. A snapshot apply waits on it: see applySnapshot.
	private adoptionsInFlight: Promise<void> = Promise.resolve();

	// Tables whose migrations are known to bring them into existence, so a repeat write
	// reads no migrations (see announceUnrecordedTables). Keyed by the catalog's schema
	// OBJECT: local and replicated DDL both register a fresh one, so any schema change
	// invalidates the entry for free, as `createPkKeyingResolver`'s cache does. A table
	// joins only once the batch that checked or announced it has committed.
	private readonly announcedTables = new WeakSet<TableSchema>();

	// Tables whose facts were already reported as uncapturable, so the warning fires
	// once per schema object rather than on every write to a scratch table.
	private readonly unwritableWarned = new WeakSet<TableSchema>();

	// Last basis hash recorded per basis schema (in-memory, advisory). Drives the
	// basis-drift warning in recordLensDeployment — a warning, not durable state.
	private readonly lastBasisHash = new Map<string, string>();

	// Cumulative unknown-table disposition counters (in-memory, observe-only —
	// mirrors the engine's materialized-view collision stats).
	private unknownTableIgnored = 0;
	private unknownTableQuarantined = 0;
	private unknownTableForwarded = 0;
	// Cumulative forwardable changes re-offered through getChangesSince or
	// getChangesToPush (the store-and-forward relay's outbound activity). Distinct from
	// unknownTableForwarded, which counts apply-time holds: a held entry is held
	// ONCE but relayed possibly MANY times until GC, so this counter grows with
	// relay activity, not with distinct stragglers. Bumped in collectForwardableChanges.
	private unknownTableRelayed = 0;
	private readonly unknownTableByTable = new Map<string, number>();

	private constructor(
		kv: KVStore,
		config: SyncConfig,
		hlcManager: HLCManager,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback,
		dropLocalTable?: DropLocalTableCallback,
		keyNormalizerResolver?: KeyNormalizerResolver,
		db?: Database,
	) {
		this.kv = kv;
		this.config = config;
		this.hlcManager = hlcManager;
		this.syncEvents = syncEvents;
		this.applyToStore = applyToStore;
		this.getTableSchema = getTableSchema;
		this.dropLocalTable = dropLocalTable;
		this.db = db;
		this.pkKeying = createPkKeyingResolver(getTableSchema, keyNormalizerResolver);
		// Same default `createPkKeyingResolver` applies, so a retired key resolves exactly as the live one did.
		this.keyNormalizerResolver = keyNormalizerResolver ?? BUILTIN_KEY_NORMALIZER_RESOLVER;
		// Loaded by `create()` before any store is used; every per-row record store
		// resolves its key's table component through it.
		this.tableIdentity = new TableIdentityStore(kv);
		this.columnVersions = new ColumnVersionStore(kv, this.pkKeying, this.tableIdentity);
		this.tombstones = new TombstoneStore(kv, config.retentionHorizonMs, this.pkKeying, this.tableIdentity);
		this.peerStates = new PeerStateStore(kv);
		this.deltaFloor = new DeltaFloorStore(kv);
		this.changeLog = new ChangeLogStore(kv, this.pkKeying, this.tableIdentity);
		this.schemaMigrations = new SchemaMigrationStore(kv);
		this.quarantine = new QuarantineStore(kv);
		this.basisLifecycle = new BasisLifecycleStore(kv);
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
	 * @param dropLocalTable - Optional reclaim-by-name callback for the basis-table
	 *   eviction sweep; when absent (e.g. a relay-only coordinator) the sweep is a no-op.
	 * @param keyNormalizerResolver - Optional collation-name → key-normalizer resolver
	 *   (pass the engine's `db.getKeyNormalizerResolver()`), used to build pk-identity
	 *   keys that agree with the database's row identity. When absent, a built-ins-only
	 *   resolver (BINARY/NOCASE/RTRIM) is used, which throws on custom collation names.
	 */
	static async create(
		kv: KVStore,
		transactionSource: TransactionCommitSource | undefined,
		config: SyncConfig,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback,
		dropLocalTable?: DropLocalTableCallback,
		keyNormalizerResolver?: KeyNormalizerResolver,
	): Promise<SyncManagerImpl> {
		// Load or create site identity
		const siteIdKey = new TextEncoder().encode(SITE_ID_KEY);
		let siteId: SiteId;

		const existingIdentity = await kv.get(siteIdKey);

		// Sync-metadata format gate: the key layout has changed across versions (see
		// SYNC_METADATA_FORMAT_VERSION); older metadata is unreadable under the
		// current layout, and writing new-format records beside it would corrupt
		// both. A replica with existing identity but a missing/mismatched version
		// must re-bootstrap from a peer snapshot (docs/sync.md § Metadata format
		// version) — refuse loudly rather than silently mis-keying.
		const formatData = await kv.get(SYNC_KEY_PREFIX.FORMAT_VERSION);
		const storedFormat = formatData ? parseInt(new TextDecoder().decode(formatData), 10) : undefined;
		if (storedFormat === undefined) {
			if (existingIdentity) {
				throw new QuereusError(
					`Sync metadata predates format version ${SYNC_METADATA_FORMAT_VERSION}. `
						+ `Clear this replica's sync metadata and re-bootstrap from a peer snapshot (docs/sync.md § Metadata format version).`,
					StatusCode.ERROR,
				);
			}
			await kv.put(SYNC_KEY_PREFIX.FORMAT_VERSION, new TextEncoder().encode(String(SYNC_METADATA_FORMAT_VERSION)));
		} else if (storedFormat !== SYNC_METADATA_FORMAT_VERSION) {
			throw new QuereusError(
				`Sync metadata format version ${storedFormat} does not match this build's ${SYNC_METADATA_FORMAT_VERSION}. `
					+ `Clear this replica's sync metadata and re-bootstrap from a peer snapshot (docs/sync.md § Metadata format version).`,
				StatusCode.ERROR,
			);
		}

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
		const manager = new SyncManagerImpl(
			kv, config, hlcManager, syncEvents, applyToStore, getTableSchema, dropLocalTable, keyNormalizerResolver,
			databaseOf(transactionSource),
		);

		// The name ↔ generation map is bounded by the table count, so it is held whole
		// in memory; load it before the first commit can be captured below.
		await manager.tableIdentity.load();

		// Capture local changes at the engine transaction boundary: one grouped
		// `onTransactionCommit` batch ⇒ one transaction ⇒ one HLC. The store's
		// per-table emitter is below the transaction boundary and cannot group a
		// multi-table transaction (docs/sync-transactions.md § Transaction-Based Change Grouping),
		// so we subscribe here, not there. Omitted for relay-only deployments.
		transactionSource?.onTransactionCommit((batch) => {
			manager.enqueueTransactionCommit(batch);
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

	/** See {@link SyncContext.getPkKeying}. */
	getPkKeying(schema: string, table: string): PkKeying {
		return this.pkKeying(schema, table);
	}

	/** See {@link SyncContext.hasSchemaOracle}. */
	get hasSchemaOracle(): boolean {
		return this.getTableSchema !== undefined;
	}

	/**
	 * Basis-membership oracle for unknown-table detection. `getTableSchema(s,t)
	 * === undefined` ⇒ the table is outside the local basis. When no oracle was
	 * provided (e.g. a relay-only coordinator), detection is inert: every table
	 * reports in-basis and the store adapter's defensive throw governs.
	 */
	isTableInBasis(schema: string, table: string): boolean {
		return this.getTableSchema ? this.getTableSchema(schema, table) !== undefined : true;
	}

	/** See {@link SyncContext.isMaterializedView}. */
	isMaterializedView(schema: string, table: string): boolean {
		return this.getTableSchema?.(schema, table)?.derivation !== undefined;
	}

	/**
	 * Current column names for an in-basis table via the `getTableSchema` oracle, or
	 * `undefined` when the table is outside the basis (oracle returns nothing) OR no
	 * oracle was wired. Backs the drain path's basis gate + schema-drift filter (see
	 * {@link SyncContext.getTableColumnNames}). The no-oracle `undefined` makes drain
	 * a clean no-op on a relay-only coordinator, exactly as detection is inert there.
	 */
	getTableColumnNames(schema: string, table: string): readonly string[] | undefined {
		return this.getTableSchema?.(schema, table)?.columns?.map(c => c.name);
	}

	/** See {@link SyncContext.getTableKeyColumns}. */
	getTableKeyColumns(schema: string, table: string): readonly string[] | undefined {
		const tableSchema = this.getTableSchema?.(schema, table);
		// `?.` on a non-optional field: test oracles stub `{ columns }`-only schemas.
		return tableSchema?.primaryKeyDefinition?.map(def => tableSchema.columns[def.index].name);
	}

	/** See {@link SyncContext.getPkKeyingOf}. */
	getPkKeyingOf(schema: string, table: string, keyColumns: readonly string[]): PkKeying | undefined {
		const tableSchema = this.getTableSchema?.(schema, table);
		if (!tableSchema) return undefined;
		const primaryKeyDefinition: Array<{ index: number }> = [];
		for (const name of keyColumns) {
			const index = tableSchema.columnIndexMap.get(name.toLowerCase());
			if (index === undefined) return undefined;
			primaryKeyDefinition.push({ index });
		}
		// The same per-column recipe the live keying uses, over the retired key's columns.
		return resolvePkKeying({ ...tableSchema, primaryKeyDefinition }, this.keyNormalizerResolver);
	}

	/**
	 * Accumulate unknown-table disposition stats (called by the apply path after a
	 * diverted group is successfully admitted).
	 */
	recordUnknownTable(
		disposition: UnknownTableDisposition,
		schema: string,
		table: string,
		changeCount: number,
	): void {
		if (disposition === 'quarantine') {
			this.unknownTableQuarantined += changeCount;
		} else if (disposition === 'store-and-forward') {
			this.unknownTableForwarded += changeCount;
		} else {
			this.unknownTableIgnored += changeCount;
		}
		// byTable is the union across all dispositions (the per-disposition counters
		// partition it) — accumulated unconditionally, never against `forwarded` alone.
		const key = `${schema}.${table}`;
		this.unknownTableByTable.set(key, (this.unknownTableByTable.get(key) ?? 0) + changeCount);
	}

	getUnknownTableStats(): { ignored: number; quarantined: number; forwarded: number; relayed: number; byTable: Map<string, number> } {
		return {
			ignored: this.unknownTableIgnored,
			quarantined: this.unknownTableQuarantined,
			forwarded: this.unknownTableForwarded,
			relayed: this.unknownTableRelayed,
			byTable: new Map(this.unknownTableByTable),
		};
	}

	// ============================================================================
	// Basis-table lifecycle (legacy-table retirement bookkeeping)
	// ============================================================================

	/**
	 * Record one logical schema's lens deployment over its basis, recomputing the
	 * durable per-basis-table lifecycle classification (`docs/migration.md`
	 * § 2 Converge). See {@link SyncManager.recordLensDeployment}.
	 *
	 * The snapshot is scoped to ONE logical schema, so this schema's directly-mapped
	 * contribution is stored per-schema (`mappedBy`) and the aggregate state ORs all
	 * schemas — a basis table stays `directly-mapped` until the last mapper drops it.
	 * The classification is a pure function of `(snapshot, basis schema)`, both
	 * reachable from `db`: the directly-mapped set is the union of every table
	 * snapshot's `relationBacking` keys (plus deferred surrogate-split members), and
	 * the basis membership / derivation sources come from enumerating the basis
	 * schema's tables.
	 */
	async recordLensDeployment(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): Promise<void> {
		const logical = logicalSchemaName.toLowerCase();

		// This schema's directly-mapped contribution: the union of every table
		// snapshot's basis relations. surrogateMemberKeys mark deferred surrogate-split
		// members that back the table INDIRECTLY — fold them in as referenced so a
		// deferred member is never misclassified as an eviction candidate.
		const directlyMapped = new Set<string>();
		for (const tableSnapshot of snapshot.tables.values()) {
			for (const key of tableSnapshot.relationBacking.keys()) directlyMapped.add(key);
			if (tableSnapshot.surrogateMemberKeys) {
				for (const key of tableSnapshot.surrogateMemberKeys) directlyMapped.add(key);
			}
		}

		// Enumerate the basis schema (the common case is `main`, but the basis may be
		// an attached schema — resolve by name). basisMembership = all table keys;
		// derivationSources = union of every maintained table's sourceTables.
		const basisSchema = db.schemaManager.getSchema(snapshot.basisSchemaName);
		const basisMembership = new Set<string>();
		const derivationSources = new Set<string>();
		const displayName = new Map<string, { schema: string; table: string }>();
		// Snapshot the eviction-policy tag + secondary-index names of each in-basis
		// table NOW: both are gone once the table detaches (its schema + tag vanish),
		// and the eviction sweep needs the index list to reclaim index stores by name.
		const evictPolicyByKey = new Map<string, EvictPolicy>();
		const indexNamesByKey = new Map<string, string[]>();
		if (basisSchema) {
			for (const table of basisSchema.getAllTables()) {
				const key = `${table.schemaName}.${table.name}`.toLowerCase();
				basisMembership.add(key);
				displayName.set(key, { schema: table.schemaName, table: table.name });
				for (const src of table.derivation?.sourceTables ?? []) {
					derivationSources.add(src.toLowerCase());
				}
				const policy = parseEvictPolicyTag(table.tags?.[SYNC_EVICT_TAG] ?? null);
				if (policy !== undefined) evictPolicyByKey.set(key, policy);
				const indexNames = (table.indexes ?? []).map(i => i.name);
				if (indexNames.length > 0) indexNamesByKey.set(key, indexNames);
			}
		} else if (snapshot.basisSchemaName) {
			console.warn(
				`[Sync] recordLensDeployment: basis schema '${snapshot.basisSchemaName}' not found; basis membership treated as empty`,
			);
		}

		// Basis-drift detection: warn (don't silently reclassify) when the basis hash
		// changed out-of-band vs. the last deploy we recorded for this basis.
		const priorHash = this.lastBasisHash.get(snapshot.basisSchemaName);
		if (priorHash !== undefined && priorHash !== snapshot.basisHash) {
			console.warn(
				`[Sync] recordLensDeployment: basis '${snapshot.basisSchemaName}' hash drifted out-of-band `
					+ `(recorded ${priorHash || '∅'}, current ${snapshot.basisHash || '∅'})`,
			);
		}
		this.lastBasisHash.set(snapshot.basisSchemaName, snapshot.basisHash);

		const stored = await this.basisLifecycle.getAll();

		// The universe of basis-relation keys to (re)classify: the current basis +
		// its derivation sources + this schema's directly-mapped set + every stored
		// record. directlyMapped is folded in (beyond the ticket's literal
		// membership/derivation/stored universe) so every relation the lens maps is
		// tracked even in the defensive case where the basis schema can't be resolved
		// — a no-op normally, since a mapped relation is a real basis table. Stored
		// keys keep an empty/detach deploy revisiting tables it no longer maps.
		const keys = new Set<string>([...basisMembership, ...derivationSources, ...directlyMapped, ...stored.keys()]);

		const now = Date.now();
		const batch = this.kv.batch();
		let wroteAny = false;
		const pendingEvents: BasisTableLifecycleEvent[] = [];
		// Tables transitioning detached → present this deploy: a retired table the lens
		// re-maps back into the basis. Its held out-of-basis changes should replay NOW
		// (after the lifecycle records are durable) rather than waiting on the periodic
		// sweep — the lens-redeploy sibling of the inbound-create_table reappearance path.
		const reappeared: Array<{ schema: string; table: string }> = [];

		for (const key of keys) {
			const prior = stored.get(key);

			// OR this schema's contribution into the per-schema mapper set: add when it
			// maps the table now, remove when it no longer does (so the LAST mapper
			// dropping it is what flips the aggregate off directly-mapped).
			const mapped = new Set((prior?.mappedBy ?? []).map(s => s.toLowerCase()));
			if (directlyMapped.has(key)) mapped.add(logical);
			else mapped.delete(logical);
			const mappedBy = [...mapped].sort();

			const derivationSource = derivationSources.has(key);
			const inBasis = basisMembership.has(key);
			const state = classifyBasisLifecycle(mappedBy, derivationSource, inBasis);

			// Stamp mapped-since on entry into directly-mapped (clearing any prior
			// unmapped-since); unmapped-since on exit from it (the retirement hint).
			const wasMapped = prior?.state === 'directly-mapped';
			const isMapped = state === 'directly-mapped';
			let mappedSince = prior?.mappedSince;
			let unmappedSince = prior?.unmappedSince;
			if (isMapped && !wasMapped) {
				mappedSince = now;
				unmappedSince = undefined;
			} else if (!isMapped && wasMapped) {
				unmappedSince = now;
			}

			// Stamp detached-at on entry into detached (the eviction quiet-clock
			// fallback when the table was never directly mapped); clear it on re-attach.
			const wasDetached = prior?.state === 'detached';
			const isDetached = state === 'detached';
			let detachedAt = prior?.detachedAt;
			if (isDetached && !wasDetached) detachedAt = now;
			else if (!isDetached) detachedAt = undefined;

			// Eviction override + index list: while in-basis the tag/index list are
			// authoritative (re-captured each deploy, so a removed tag clears the
			// override); once out of basis they are gone, so carry the prior record's.
			const evictPolicy = inBasis ? evictPolicyByKey.get(key) : prior?.evictPolicy;
			const indexNames = inBasis ? indexNamesByKey.get(key) : prior?.indexNames;

			const display = displayName.get(key)
				?? (prior ? { schema: prior.schema, table: prior.table } : splitRelKey(key));

			const record: BasisTableLifecycleRecord = {
				schema: display.schema,
				table: display.table,
				state,
				mappedBy,
				derivationSource,
				inBasis,
				...(mappedSince !== undefined ? { mappedSince } : {}),
				...(unmappedSince !== undefined ? { unmappedSince } : {}),
				...(detachedAt !== undefined ? { detachedAt } : {}),
				// The dynamic signal is owned by the change applicator — carry through here.
				...(prior?.lastDirectlyMappedWriteAt !== undefined ? { lastDirectlyMappedWriteAt: prior.lastDirectlyMappedWriteAt } : {}),
				...(evictPolicy !== undefined ? { evictPolicy } : {}),
				...(indexNames && indexNames.length > 0 ? { indexNames } : {}),
			};

			if (!prior || basisLifecycleRecordChanged(prior, record)) {
				this.basisLifecycle.put(batch, record);
				wroteAny = true;
			}
			// Emit only on an ACTUAL state change of an already-tracked table — a
			// brand-new table's first classification and an idempotent re-apply emit
			// nothing (a spurious event would mislead the retirement hint).
			if (prior && prior.state !== state) {
				pendingEvents.push({
					schema: record.schema,
					table: record.table,
					previousState: prior.state,
					newState: state,
					at: now,
				});
			}

			// Detached → present (any in-basis state): a previously-retired table this
			// deploy re-mapped back into the basis — its held out-of-basis changes should
			// replay now. Use the precise `detached → present` transition rather than the
			// broader "inBasis newly true": held entries only ever exist for previously
			// out-of-basis tables, so the precise check skips spurious scoped scans for
			// brand-new tables (excluded anyway by the `prior` guard). A cheapness
			// optimization, not a correctness gate — drainHeldChanges' oracle gate makes
			// any over-trigger a harmless no-op.
			if (wasDetached && !isDetached) {
				reappeared.push({ schema: record.schema, table: record.table });
			}
		}

		if (wroteAny) await batch.write();

		// Emit AFTER the records are durable, so a listener that reads back
		// getBasisTableLifecycle() sees the committed transition.
		for (const event of pendingEvents) {
			this.syncEvents.emitBasisTableLifecycle(event);
		}

		// Reactive low-latency drain (sync-drain-reappear-lens-redeploy): a table this
		// deploy re-mapped detached → present may hold out-of-basis changes waiting on it.
		// Replay them as a SEPARATE post-commit apply unit, after the lifecycle batch above
		// is durable and its events have fired, so the oracle (getTableColumnNames) sees the
		// re-attached table and the held changes LWW-resolve against the present basis —
		// instead of waiting up to one periodic-sweep interval. Symmetric with the
		// inbound-create_table path in applyChanges. Advisory: drainReappearedTables logs +
		// swallows any per-table failure, so a drain throw never aborts the deploy (which is
		// itself advisory bookkeeping — the store-module forwarder wraps it in try/catch).
		//
		// RE-ENTRANCY: in production this runs inside the firing `apply schema` statement,
		// which holds the engine exec mutex (the module `notifyLensDeployment` hook is awaited
		// mid-statement). The drain re-enters the engine via `applyToStore` →
		// `db.ingestExternalRowChanges`, which acquires that same mutex — awaiting it inline
		// would deadlock (the statement can't release the mutex until this returns). So when
		// the engine reports it is mid-statement, defer the drain to fire-and-forget: it queues
		// on the mutex and runs the instant `apply schema` commits and releases it (callers
		// observe the drained rows after the capture settle, exactly like the local-change
		// capture). Outside a live statement (e.g. unit tests over a stub store that never
		// touches the engine mutex), await inline so the drain completes before returning.
		if (reappeared.length > 0) {
			if (db._isExecuting?.()) {
				void this.trackApply(drainReappearedTables(this, reappeared));
			} else {
				await this.trackApply(drainReappearedTables(this, reappeared));
			}
		}
	}

	async getBasisTableLifecycle(): Promise<BasisTableLifecycleRecord[]> {
		return this.basisLifecycle.list();
	}

	/**
	 * Reclaim the local storage of every detached basis table that has been quiet
	 * past its effective retention horizon (`docs/migration.md` § 4 Contract).
	 * Host-driven (like {@link pruneTombstones} / {@link pruneQuarantine}) — the
	 * host schedules it; the library adds no timer. Returns the number of tables
	 * evicted.
	 *
	 * No-op when no `dropLocalTable` reclaim callback is wired (e.g. a relay-only
	 * coordinator with no store). For each evictable record it re-reads the record
	 * and re-checks eligibility immediately before dropping — guarding against a
	 * concurrent re-deploy that re-mapped the table between the scan and the drop —
	 * then drops the storage, emits `onBasisTableEvicted`, and clears the record. A
	 * `dropLocalTable` throw leaves the record in place to retry next sweep (the
	 * drop is idempotent).
	 */
	async evictExpiredBasisTables(now: number = Date.now()): Promise<number> {
		if (!this.dropLocalTable) return 0;

		const records = await this.basisLifecycle.list();
		let evicted = 0;
		for (const candidate of records) {
			if (!isEvictable(candidate, now, this.config)) continue;

			// Re-read + re-check immediately before the drop: a concurrent re-deploy
			// may have re-mapped (and so re-attached) the table since the scan.
			const fresh = await this.basisLifecycle.get(candidate.schema, candidate.table);
			if (!fresh || fresh.state !== 'detached' || !isEvictable(fresh, now, this.config)) continue;

			try {
				await this.dropLocalTable(fresh.schema, fresh.table, fresh.indexNames ?? []);
			} catch (error) {
				// Leave the record; retry next sweep. The drop is idempotent, so a
				// partial reclaim is re-attempted rather than stranded.
				console.warn(
					`[Sync] evictExpiredBasisTables: dropLocalTable failed for '${fresh.schema}.${fresh.table}'; `
						+ `record retained for retry: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			// Storage reclaimed — clear the record (a later re-create starts fresh) and
			// emit AFTER the drop succeeded.
			await this.basisLifecycle.delete(fresh.schema, fresh.table);
			this.syncEvents.emitBasisTableEvicted({
				schema: fresh.schema,
				table: fresh.table,
				at: now,
				quietForMs: now - quietSince(fresh),
			});
			evicted++;
		}
		return evicted;
	}

	// ============================================================================
	// Local change capture (engine transaction boundary)
	// ============================================================================

	/**
	 * Serialize commit recording: chain each commit onto the prior handler's
	 * completion so N+1's dedup reads observe N's durable writes (the change-log
	 * ordering invariant, docs/sync-transactions.md § Transaction-Based Change Grouping). The
	 * defensive `.catch` guards the tail: `handleTransactionCommit` already swallows
	 * and telemeters its own errors, but any unexpected throw must not poison the
	 * chain for every subsequent commit. Returns `void` — fire-and-forget from the
	 * engine's perspective; only inter-handler ordering changes.
	 */
	enqueueTransactionCommit(batch: TransactionCommitBatch): void {
		this.commitChain = this.commitChain
			.then(() => this.handleTransactionCommit(batch))
			.catch(error => console.error('[Sync] Commit chain link failed:', error));
	}

	/**
	 * Await the commit-recording tail — resolves once every commit enqueued so far
	 * has fully recorded (through its KV batch write). Test/diagnostic hook for
	 * deterministic draining without a timed sleep.
	 */
	whenCommitsSettled(): Promise<void> {
		return this.commitChain;
	}

	/** See {@link SyncContext.onCommitChain}. */
	onCommitChain<T>(work: () => Promise<T>): Promise<T> {
		const running = this.commitChain.then(work);
		this.commitChain = running.then(() => undefined, () => undefined);
		return running;
	}

	/** See {@link SyncContext.nextFilingTick}. */
	nextFilingTick(): Promise<HLC> {
		return this.onCommitChain(async () => {
			const tick = this.hlcManager.tick();
			await persistHLCState(this);
			return tick;
		});
	}

	/** See {@link SyncContext.whenAppliesSettled}. */
	whenAppliesSettled(): Promise<void> {
		return this.appliesInFlight;
	}

	/** The `then` drops the results: keeping them would link every past apply into one growing chain. */
	private trackApply<T>(applying: Promise<T>): Promise<T> {
		this.appliesInFlight = Promise.allSettled([this.appliesInFlight, applying]).then(() => undefined);
		return applying;
	}

	/**
	 * Record one committed local transaction, telling listeners rather than the caller
	 * if that fails: nobody awaits this but the commit chain, which must stay usable.
	 */
	private async handleTransactionCommit(batch: TransactionCommitBatch): Promise<void> {
		try {
			await this.recordCommitBatch(batch);
		} catch (error) {
			console.error('[Sync] Error handling transaction commit:', error);
			this.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
			// The abandoned batch may have staged identity transitions and lazy mints
			// the in-memory index already reflects; re-read it from disk. This handler
			// swallows its own errors (the chain must stay usable), so the re-read's too.
			try {
				await this.tableIdentity.load();
			} catch (reloadError) {
				console.error('[Sync] Table identity index could not be re-read after the failed capture:', reloadError);
			}
		}
	}

	/**
	 * Record CRDT metadata for one local transaction, throwing on failure.
	 *
	 * Driven by the engine's `onTransactionCommit` group — the authoritative
	 * "one transaction = one HLC" boundary — or by a synthetic group from adoption. The
	 * clock is ticked exactly **once**; every fact of the transaction shares that base
	 * `(wallTime, counter, siteId)` and differs only in `opSeq` (a contiguous, 0-based
	 * sub-order). Each fact is filed in the change log at that same HLC: for a fact
	 * written here, the origin timestamp and the filing position are one value
	 * (`metadata/filing-position.ts`). DDL is recorded before DML so migrations sort
	 * below the same
	 * transaction's data facts (docs/sync-schema.md § DDL Application Order). All metadata
	 * for the transaction — schema migrations, column versions, tombstones, change-log
	 * entries, and the HLC clock state — lands in a single KV batch.
	 *
	 * A table the facts belong to that no recorded migration brought into existence is
	 * announced with them ({@link announceUnrecordedTables}), so its definition reaches
	 * every device that lacks it.
	 */
	private async recordCommitBatch(batch: TransactionCommitBatch): Promise<void> {
		// Capture only LOCAL facts. An all-remote group is a pure sync-apply echo:
		// its metadata was already recorded by the apply path. A mixed group
		// (local + remote in one transaction — unusual) records only its local
		// facts; opSeq is assigned only to recorded facts so they stay contiguous.
		const localSchema = batch.schemaEvents.filter(e => !e.remote);
		const localData = this.filterCapturableDataEvents(
			batch.dataEvents.filter(e => !e.remote),
			localSchema,
		);
		if (localSchema.length === 0 && localData.length === 0) return;

		// Announcements come AFTER the transaction's own schema events: a rename in the
		// same transaction must `move` the table's generation before the announcement's
		// `ensure` under the new name, which would otherwise mint a second one. An
		// ordinary announcement is recorded like any local create; a baseline is
		// recorded at version 0, after the real migrations, by `recordBaselineMigration`.
		const announced = await this.announceUnrecordedTables(localSchema, localData);
		const schemaEvents = [...localSchema, ...announced.ordinary];

		// ONE tick per committed transaction. tick() returns opSeq 0; the closure
		// below stamps each successive fact with the next opSeq off the same base.
		const base = this.hlcManager.tick();
		const transactionId = deterministicTxnId(base);

		let opSeq = 0;
		const nextHlc = (): HLC => {
			// Throw rather than wrap the uint32.
			assertOpSeqInRange(opSeq);
			return createHLC(base.wallTime, base.counter, base.siteId, opSeq++);
		};

		const kvBatch = this.kv.batch();
		const changes: Change[] = [];
		// Read-your-own-writes overlay: everything staged into kvBatch is noted
		// here so a later event of the SAME transaction reads its own staged
		// metadata instead of pre-transaction storage (see
		// staged-transaction-metadata.ts). Lives for this one commit.
		const staged = new StagedTransactionMetadata((schema, table) => this.getPkKeying(schema, table));

		// Table-identity transitions FIRST, ahead of the data records: `drop t;
		// create t; insert into t` must file its rows under the NEW generation, and
		// a rename's rows (relabelled to the new name by the engine) under the moved
		// one. Same batch as everything else, so the mapping and the records that
		// depend on it commit together.
		await this.applyLocalTableTransitions(kvBatch, [...schemaEvents, ...announced.baseline]);

		// DDL before DML: migrations take the lowest opSeqs. A primary-key change also
		// re-files the table's existing records here, BEFORE the data events below — the
		// engine already re-keyed those, so they must overwrite re-filed records, not the
		// reverse — and is reported only once the batch has committed.
		const versionCounters = new Map<string, number>();
		const rekeyed: Array<{ schema: string; table: string; counts: RekeyCounts }> = [];
		for (const event of schemaEvents) {
			await this.recordSchemaMigration(kvBatch, event, nextHlc, versionCounters);
			const counts = await this.rekeyOnLocalKeyChange(kvBatch, event, staged);
			if (counts) rekeyed.push({ schema: event.schemaName, table: event.objectName, counts });
		}
		for (const event of announced.baseline) {
			this.recordBaselineMigration(kvBatch, event, nextHlc);
		}

		for (const event of localData) {
			await this.recordDataEvent(kvBatch, event, nextHlc, changes, staged);
		}

		// Persist HLC clock state (wallTime/counter only — opSeq is never persisted).
		persistHLCStateBatch(this, kvBatch);

		await kvBatch.write();

		// Only now: a batch that failed announced nothing, and must be announced again.
		for (const definition of announced.settled) this.announcedTables.add(definition);
		for (const { schema, table, counts } of rekeyed) reportRekeyOutcome(this, schema, table, counts);
		this.syncEvents.emitLocalChange({
			transactionId,
			changes,
			pendingSync: true,
		});
	}

	/**
	 * Map one transaction's LOCAL table lifecycle events onto the identity store's
	 * three transitions (`metadata/table-identity.ts`): a `create` of a table ensures
	 * its generation, a `drop` retires it, and an `alter` carrying `oldObjectName` —
	 * the shape only the `RENAME TO` emit sites produce, see
	 * {@link mapSchemaMigrationType} — moves it. Remote-flagged events never reach
	 * here (the caller filtered them); their transitions are driven by the apply path
	 * from the store adapter's executed list. Column and index events change the
	 * table, not which table it is, and are skipped. Events are walked in emit
	 * order, so a `drop t; create t` retires before it ensures.
	 */
	private async applyLocalTableTransitions(batch: WriteBatch, localSchema: DatabaseSchemaChangeEvent[]): Promise<void> {
		for (const event of localSchema) {
			if (event.objectType !== 'table') continue;
			if (event.type === 'create') {
				this.tableIdentity.ensure(event.schemaName, event.objectName, batch);
			} else if (event.type === 'drop') {
				await this.tableIdentity.retire(event.schemaName, event.objectName, batch);
			} else if (event.type === 'alter' && event.oldObjectName !== undefined) {
				this.tableIdentity.move(event.schemaName, event.oldObjectName, event.objectName, batch);
			}
		}
	}

	/**
	 * Re-file a table's bookkeeping when a LOCAL `alter`/`table` event is an ALTER
	 * PRIMARY KEY (`rekey-on-pk-change.ts`): staged into the transaction's own `batch`,
	 * and noted into `staged` so a later event of the same transaction reads the re-filed
	 * version rather than committed storage. Both keys come from the event itself — the
	 * retired one as `oldKeyColumns`, the installed one from its `ddl` — never from the
	 * catalog, which a later key change may already have moved on by the time this
	 * capture runs (the commit chain lags the engine).
	 */
	private async rekeyOnLocalKeyChange(
		batch: WriteBatch,
		event: DatabaseSchemaChangeEvent,
		staged: StagedTransactionMetadata,
	): Promise<RekeyCounts | undefined> {
		if (event.objectType !== 'table' || event.type !== 'alter' || event.oldObjectName !== undefined) return undefined;
		const newKeyColumns = alterPrimaryKeyColumns(event.ddl);
		if (newKeyColumns === undefined) return undefined;
		if (event.oldKeyColumns === undefined) {
			console.warn(
				`[Sync] ${event.schemaName}.${event.objectName}: primary key changed but the event does not name the retired key `
					+ `(a module announcing without the pre-ALTER schema) — sync bookkeeping for its existing rows cannot be re-filed`,
			);
			return undefined;
		}
		return rekeyTableBookkeeping(this, event.schemaName, event.objectName, event.oldKeyColumns, newKeyColumns, batch, staged);
	}

	/**
	 * Drop the data events of any table that is no longer in the local basis — the
	 * schema oracle does not know it, typically because this same transaction dropped
	 * it and the schema is already gone by the time the commit group is delivered.
	 * A schemaless table has no sound pk identity (see `metadata/pk-identity.ts`), so
	 * its rows cannot be filed.
	 *
	 * Local capture is therefore best-effort at TABLE granularity: one unknown table
	 * costs only its own rows, never the rest of the transaction (which is what the
	 * handler's top-level catch would do — it aborts recording of every other table's
	 * rows AND the transaction's schema migrations).
	 *
	 * Runs BEFORE the HLC tick, so a transaction whose data is entirely skipped and
	 * that carries no schema events consumes no clock and emits no local change,
	 * mirroring the all-remote echo early-out. Filtering up front also means no event
	 * is ever half-recorded: the throw it replaces could fire *after* a tombstone had
	 * already been staged into the shared `WriteBatch`.
	 *
	 * The gate is basis MEMBERSHIP, not "this transaction dropped the table":
	 * `drop t; create t; insert into t` carries a drop event for `t` yet leaves it in
	 * basis, and its rows must still be captured. `localSchema` is consulted only to
	 * classify the log line — an expected skip reads differently from a table that
	 * vanished for some other reason.
	 *
	 * Also dropped: the events of a table no receiver could write to (`receiversCanWrite`
	 * — a `memory` table, say). One such cell fails a receiver's whole batch and strands
	 * a new device's snapshot, and no definition can help, since the receiver has no way
	 * to write the table at all. Gated on an apply path being wired, as adoption is: a
	 * manager with none (a relay, or a test over a stub store) has no receivers to
	 * protect. A definition with no module at all is a test oracle's stub and is left
	 * alone.
	 *
	 * ONLY those cases are skipped. Any other keying failure — a pk column whose
	 * collation the wired `keyNormalizerResolver` does not know, say — still throws out
	 * of `recordDataEvent` and fails the transaction loudly; silently discarding those
	 * rows would bury a real misconfiguration.
	 *
	 * A relay-only manager (no `getTableSchema` oracle) reports every table in basis,
	 * so nothing is skipped there.
	 */
	private filterCapturableDataEvents(
		events: DatabaseDataChangeEvent[],
		localSchema: DatabaseSchemaChangeEvent[],
	): DatabaseDataChangeEvent[] {
		// NOTE: one oracle lookup per ROW (a schema-map hit today, and dwarfed by the
		// per-row record work below). If `getTableSchema` ever becomes expensive, memo
		// the verdict per table for the duration of the transaction.
		const skips = new Map<string, SkippedTable>();
		const kept = events.filter(event => {
			const skip = this.captureSkip(event.schemaName, event.tableName, localSchema);
			if (!skip) return true;
			const tableKey = `${event.schemaName}.${event.tableName}`;
			const seen = skips.get(tableKey);
			if (seen) seen.count++;
			else skips.set(tableKey, { ...skip, count: 1 });
			return false;
		});

		if (skips.size > 0) this.logSkippedTables(skips);
		return kept;
	}

	/** Why one table's facts are not captured, or `undefined` when they are. */
	private captureSkip(
		schema: string,
		table: string,
		localSchema: DatabaseSchemaChangeEvent[],
	): Omit<SkippedTable, 'count'> | undefined {
		if (!this.getTableSchema) return undefined;
		const definition = this.getTableSchema(schema, table);
		if (!definition) {
			const droppedHere = localSchema.some(e =>
				e.objectType === 'table' && e.type === 'drop' && e.schemaName === schema && e.objectName === table);
			return { reason: droppedHere ? 'dropped here' : 'outside the basis' };
		}
		if (this.applyToStore && definition.vtabModule !== undefined && !receiversCanWrite(definition)) {
			return { reason: 'unwritable', definition };
		}
		return undefined;
	}

	/**
	 * Report skipped tables: ONE line per table with its change count, never one per
	 * row. A table this same transaction dropped is expected and logs informationally;
	 * a table that vanished for some other reason is a warning. A table no receiver
	 * can write is warned about once per schema object, since every write to a scratch
	 * table would otherwise repeat it.
	 */
	private logSkippedTables(skips: ReadonlyMap<string, SkippedTable>): void {
		// NOTE: the only `console.log` in this package (everything else is warn/error) —
		// an expected skip is not a warning. If the package ever gains a real logger
		// abstraction, this is the call site that wants an `info` level.
		for (const [tableKey, { count, reason, definition }] of skips) {
			if (reason === 'dropped here') {
				console.log(`[Sync] Skipped ${count} change(s) for ${tableKey} — table dropped by the same transaction`);
			} else if (reason === 'outside the basis') {
				console.warn(`[Sync] Skipped ${count} change(s) for ${tableKey} — table is outside the local basis, so sync pk identity is unresolvable`);
			} else if (definition && !this.unwritableWarned.has(definition)) {
				this.unwritableWarned.add(definition);
				console.warn(
					`[Sync] Not capturing changes to ${tableKey}: other devices cannot write to a table using module `
						+ `'${definition.vtabModuleName}', so its rows stay on this device`,
				);
			}
		}
	}

	/**
	 * The `create` events to record with this transaction's facts for each table they
	 * touch whose migrations never brought it into existence, usually one created before
	 * sync attached (docs/sync.md § Rows sync has never recorded). Without them the
	 * facts reach the coordinator with no definition: other devices quarantine them and
	 * a new device's snapshot cannot resolve the table at all. `announcementFor` decides
	 * what to send; this chooses the tables:
	 *
	 * - only a fact `recordDataEvent` will record — a no-op update records nothing and
	 *   leaves its row unrecorded, so it announces nothing either;
	 * - only a table a receiver could write (`receiversCanWrite`), since no definition
	 *   helps a table receivers cannot write;
	 * - not a table this transaction creates, whose own create is recorded; a table it
	 *   renames is judged by the migrations of the name storage still has.
	 *
	 * `settled` is what to remember once the batch commits: every table looked at, since
	 * after the commit each one's migrations leave it live (or it is never announced).
	 */
	private async announceUnrecordedTables(
		localSchema: DatabaseSchemaChangeEvent[],
		localData: DatabaseDataChangeEvent[],
	): Promise<{ baseline: DatabaseSchemaChangeEvent[]; ordinary: DatabaseSchemaChangeEvent[]; settled: TableSchema[] }> {
		const announced = { baseline: [] as DatabaseSchemaChangeEvent[], ordinary: [] as DatabaseSchemaChangeEvent[], settled: [] as TableSchema[] };
		if (!this.getTableSchema) return announced;

		const considered = new Set<string>();
		for (const event of localData) {
			if (!recordsAFact(event)) continue;
			const { schemaName, tableName } = event;
			const tableKey = joinKeyParts(schemaName, tableName);
			if (considered.has(tableKey)) continue;
			considered.add(tableKey);

			const definition = this.getTableSchema(schemaName, tableName);
			if (!definition || this.announcedTables.has(definition)) continue;
			announced.settled.push(definition);
			if (!receiversCanWrite(definition)) continue;

			const origin = originOfName(localSchema, schemaName, tableName);
			if (origin.createdHere) continue;
			const announcement = await announcementFor(this, definition, origin.name);
			if (announcement) announced[announcement.kind].push(...announcement.events);
		}
		return announced;
	}

	/**
	 * Record an announcement's `create` event as a baseline — schema version
	 * {@link BASELINE_SCHEMA_VERSION}, see `SchemaMigration.schemaVersion` — where
	 * {@link recordSchemaMigration} would file it as the next real version.
	 */
	private recordBaselineMigration(batch: WriteBatch, event: DatabaseSchemaChangeEvent, nextHlc: () => HLC): void {
		const migrationType = mapSchemaMigrationType(event);
		if (migrationType !== 'create_table' && migrationType !== 'add_index') {
			throw new Error(`Only a create can be recorded as a baseline, not ${event.type} ${event.objectType}`);
		}
		this.schemaMigrations.recordMigrationBatch(batch, event.schemaName, migrationObjectKind(migrationType), event.objectName, {
			type: migrationType,
			ddl: event.ddl ?? '',
			hlc: nextHlc(),
			schemaVersion: BASELINE_SCHEMA_VERSION,
		});
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
		const migrationType = mapSchemaMigrationType(event);
		if (!migrationType) return;

		const { schemaName, objectName, ddl } = event;

		// Every tracked type now carries canonical DDL — ALTER TABLE events included
		// (the engine renders the statement's schema-qualified SQL at plan-build and the
		// store module puts it on the event; see SchemaChangeInfo.ddl). A blank
		// `alter_column`/`rename_table` can therefore only come from an older event
		// producer; the migration below still records and still advances the schema
		// version (destructiveness comparison depends on it), but a blank one reaches a
		// peer as an empty statement, so it is still worth an operator hearing about.
		if ((migrationType === 'alter_column' || migrationType === 'rename_table') && !ddl?.trim()) {
			console.warn(
				`[Sync] ${schemaName}.${objectName}: recording an ${migrationType} migration with no DDL — `
					+ `this table alteration will NOT reach other synced devices`,
			);
		}

		// NOTE: for an index migration `objectName` is the INDEX name, so the counter
		// is per `(schema, kind, index name)` — index-vs-index it is unambiguous only
		// because `SchemaManager.createIndex` enforces index names unique per schema
		// (SCH-001, docs/invariants.md). Two same-named indexes on different tables
		// would otherwise share one version counter and suppress each other's
		// migrations.
		const kind = migrationObjectKind(migrationType);
		// Length-prefixed, like the stored key: a schema or object name may contain
		// any character, so a bare-delimiter join could fold two distinct objects
		// onto one in-transaction counter.
		const counterKey = joinKeyParts(schemaName, kind, objectName);
		let version = versionCounters.get(counterKey);
		if (version === undefined) {
			version = await this.schemaMigrations.getCurrentVersion(schemaName, kind, objectName);
		}
		version += 1;
		versionCounters.set(counterKey, version);

		// A rename files under the NEW name (`objectName`) with the old one in
		// `fromTable`, so later alterations of the renamed table share one contiguous
		// version stream where the table actually lives. The rename may start a fresh
		// counter under the new name (version 1 if nothing was ever named that) —
		// harmless, the same thing happens when a dropped name is reused.
		this.schemaMigrations.recordMigrationBatch(batch, schemaName, kind, objectName, {
			type: migrationType,
			...(migrationType === 'rename_table' && event.oldObjectName !== undefined
				? { fromTable: event.oldObjectName }
				: {}),
			// A key change carries the table's column layout (the engine's event names it), so
			// a relay can re-file the table's tombstones from their before-images.
			...(migrationType === 'alter_column' && event.columns !== undefined ? { columns: event.columns } : {}),
			ddl: ddl || '',
			hlc: nextHlc(),
			schemaVersion: version,
		});
	}

	/**
	 * Record one local data-change event: a tombstone (delete) or column versions
	 * (every column of an insert or of the first edit of an unrecorded row, otherwise
	 * the changed ones). Each recorded fact consumes one `opSeq`.
	 *
	 * All reads of the row's current metadata go overlay-first (`staged`), so a
	 * transaction that touches one row more than once records the same metadata
	 * the equivalent sequence of separate transactions would — and every write
	 * staged into `batch` is noted back into the overlay.
	 */
	private async recordDataEvent(
		batch: WriteBatch,
		event: DatabaseDataChangeEvent,
		nextHlc: () => HLC,
		changes: Change[],
		staged: StagedTransactionMetadata,
	): Promise<void> {
		const { schemaName, tableName, type, oldRow, newRow } = event;
		const pk = event.key;
		if (!pk) {
			console.warn(`[Sync] Missing primary key for ${schemaName}.${tableName} ${type} event — change not tracked`);
			return;
		}

		if (type === 'delete') {
			// Dedupe the change-log delete entry the same way columns are deduped: if a
			// prior tombstone exists for this pk (a delete→reinsert→delete key reuse —
			// staged by this same transaction, or committed), its stale delete entry
			// must go, so at most one delete entry survives per pk, the one filed where
			// the current tombstone is — see collectChangesSince's LOAD-BEARING
			// INVARIANT. The prior tombstone may have arrived from another replica, so
			// its entry sits at the tombstone's position, not its HLC.
			const existing = staged.tombstone(schemaName, tableName, pk)
				?? await this.tombstones.getTombstone(schemaName, tableName, pk);
			if (existing) {
				this.changeLog.deleteEntryBatch(batch, existing, 'delete', schemaName, tableName, pk);
			}

			const hlc = nextHlc();
			// Carry the row's last-known image (the engine `oldRow`) as a best-effort
			// before-image on both the persisted tombstone and the inline change. Copy
			// it so neither aliases the engine's row buffer; absent when the event
			// carried no `oldRow` (relayed/synthesized deletes).
			const priorRow: Row | undefined = oldRow ? [...oldRow] : undefined;
			this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, { hlc }, priorRow);
			this.changeLog.recordDeletionBatch(batch, { hlc }, schemaName, tableName, pk);
			// The row's column versions die here, so their change-log entries must die
			// with them — otherwise every deleted row leaves one orphan entry per column
			// behind forever (see deleteRowVersionsAndLogEntries). The cleanup stages
			// into this same `batch`, covering cells the transaction itself staged
			// (batch ordering makes these later removals win), and consults the row's
			// overlay state — captured BEFORE the notes below reset it.
			await deleteRowVersionsAndLogEntries(this, batch, schemaName, tableName, pk, {
				staged: staged.rowState(schemaName, tableName, pk),
			});
			staged.noteRowCleared(schemaName, tableName, pk);
			staged.noteTombstone(schemaName, tableName, pk, { hlc });

			const change: RowDeletion = {
				type: 'delete',
				schema: schemaName,
				table: tableName,
				pk,
				hlc,
				...(priorRow !== undefined ? { priorRow } : {}),
			};
			changes.push(change);
		} else if (newRow) {
			await this.recordColumnVersions(batch, schemaName, tableName, pk, oldRow, newRow, nextHlc, changes, staged);
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
		staged: StagedTransactionMetadata,
	): Promise<void> {
		// `col_${i}` fallback below is the live path for a RELAY-ONLY manager (no
		// schema oracle at all). An oracle-wired manager can no longer reach here for
		// a table the oracle does not know — filterCapturableDataEvents skipped it.
		const schema = this.getTableSchema?.(schemaName, tableName);
		const columnNames = schema?.columns?.map(c => c.name);
		const columnAt = (i: number): string => columnNames?.[i] ?? `col_${i}`;
		const keyColumns = new Set(schema?.primaryKeyDefinition?.map(key => key.index));

		const priors = new Map<number, ColumnVersionData | undefined>();
		for (let i = 0; i < newRow.length; i++) {
			if (cellChanged(oldRow, i, newRow[i])) {
				priors.set(i, await this.priorCellVersion(schemaName, tableName, pk, columnAt(i), staged));
			}
		}

		const cellsToRecord = oldRow && await this.isFirstEditOfUnrecordedRow(schemaName, tableName, pk, priors, staged)
			? newRow.keys()
			: priors.keys();

		for (const i of cellsToRecord) {
			const column = columnAt(i);
			const newValue = newRow[i];
			const oldVersion = priors.get(i);

			if (oldVersion) {
				this.changeLog.deleteEntryBatch(batch, oldVersion, 'column', schemaName, tableName, pk, column);
			}

			const hlc = nextHlc();
			// Carry the overwritten cell version as a best-effort before-image on
			// both the persisted version and the inline change. Spread only when a
			// prior exists — first writes carry neither field (absent, not undefined).
			// A key cell never carries one, even rewritten to a new spelling under
			// `NOCASE`: it is what shows a replica that has pruned that this row is
			// not one it forgot (`refuseEditsOfForgottenRows`).
			const prior = oldVersion && !keyColumns.has(i)
				? { priorHlc: oldVersion.hlc, priorValue: oldVersion.value }
				: undefined;
			const version: ColumnVersionData = { hlc, value: newValue, ...prior };
			this.columnVersions.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version);
			this.changeLog.recordColumnChangeBatch(batch, version, schemaName, tableName, pk, column);
			staged.noteColumnVersion(schemaName, tableName, pk, column, version);

			const change: ColumnChange = {
				type: 'column',
				schema: schemaName,
				table: tableName,
				pk,
				column,
				value: newValue,
				hlc,
				...prior,
			};
			changes.push(change);
		}
	}

	/**
	 * The version a local write to this cell replaces. Overlay first: a cell this same
	 * transaction rewrote reads its staged version (so the staged entry is the one
	 * deduped, and the before-image chains correctly); one it deleted reads as absent (a
	 * reinsert after a delete records no before-image, exactly like a first write).
	 */
	private async priorCellVersion(
		schemaName: string,
		tableName: string,
		pk: SqlValue[],
		column: string,
		staged: StagedTransactionMetadata,
	): Promise<ColumnVersionData | undefined> {
		const stagedCell = staged.columnVersion(schemaName, tableName, pk, column);
		return stagedCell === null
			? undefined                                     // staged as deleted
			: stagedCell ?? await this.columnVersions.getColumnVersion(schemaName, tableName, pk, column);
	}

	/**
	 * Whether an update is the first sync has seen of its row, which then needs every
	 * column recorded: the row has no cells, so replicas would otherwise materialize it
	 * from the changed ones alone (docs/sync.md § Rows sync has never recorded). A no-op
	 * update reads nothing and answers no, leaving the row for the `unrecordedRows` check.
	 *
	 * The overlay check is not redundant with the committed read: `alter primary key`
	 * re-files a row's cells into the transaction's batch, so committed storage shows
	 * nothing under the new key while the overlay holds them.
	 *
	 * NOTE: a remote apply writes rows before filing their records, so a local update landing
	 * in that window stamps the whole row, and the apply's metadata then overwrites those
	 * cells but leaves their change-log entries, one per column where the edited cell
	 * alone did this before. Each then points at a record filed elsewhere, which
	 * `resolveLogEntry` reads as stale, so the local edit is served to nobody. If a push
	 * ever lands inside the window and shows up as clobbered concurrent edits, have capture
	 * wait or skip while an apply is in flight.
	 *
	 * NOTE: a streaming snapshot's header clears this metadata, so a row edited during the
	 * transfer answers yes here too. A row the snapshot carries is overwritten by its table's
	 * flush, and one it lacks survives as it did before and is pushed whole, not as a
	 * fragment. Writes during a transfer stay the gap `feat-sync-bootstrap-write-gate` tracks.
	 *
	 * NOTE: a recorded row's first write of an added column also reaches the committed read,
	 * so a backfill pays one range read per row: 5000 rows took about 350 ms without it and
	 * 360-730 ms with it on LevelDB. If backfills show up in profiles, try the key cell with a
	 * `get` first, since nearly every recorded row has one.
	 *
	 * NOTE: every cell takes the edit's time, so when two devices hold the same seeded row and
	 * edit different columns, the later edit's untouched cells overwrite the earlier edit. If
	 * apps that seed shared rows report lost edits, make untouched cells lose to any real edit.
	 */
	private async isFirstEditOfUnrecordedRow(
		schemaName: string,
		tableName: string,
		pk: SqlValue[],
		priors: ReadonlyMap<number, ColumnVersionData | undefined>,
		staged: StagedTransactionMetadata,
	): Promise<boolean> {
		if (priors.size === 0) return false;
		for (const prior of priors.values()) {
			if (prior) return false;
		}
		if (staged.rowState(schemaName, tableName, pk)?.stagedColumns.size) return false;
		return !(await this.columnVersions.hasRowVersions(schemaName, tableName, pk));
	}

	// ============================================================================
	// Delta Sync API
	// ============================================================================

	/**
	 * Extract what this replica filed after `sinceHLC` for a peer, in filing order, as
	 * one {@link ChangeSet} per source transaction per filing tick, bounded at that
	 * granularity by `config.batchSize`.
	 *
	 * `sinceHLC` is a FILING POSITION on this replica (`metadata/filing-position.ts`),
	 * not a write time: the peer passes back the watermark of the last reply it applied
	 * (`replyWatermark`). So a change this replica received late, whose origin timestamp
	 * is far below the peer's watermark, is still served: it was filed above it. Two
	 * transactions are never merged, and a transaction is split only where this replica
	 * filed its facts at two ticks (docs/sync-transactions.md § Transaction-Based Change
	 * Grouping → Read side).
	 */
	async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
		// A watermark below the delta floor cannot be served in full: a delete
		// whose tombstone was pruned is missing from the reply, and nothing in it
		// says so. Warn rather than throw: the coordinator checks `canDeltaSync`
		// BEFORE calling, so only a transport that skips that check reaches this.
		if (sinceHLC && !(await this.deltaFloor.admits(sinceHLC))) {
			console.warn(
				'[Sync] getChangesSince below the delta floor: tombstones the peer needs were pruned, so this delta is incomplete — the peer should take a snapshot',
			);
		}

		const notFromPeer = (origin: HLC): boolean => !siteIdEquals(origin.siteId, peerSiteId);
		const filedAfter = (migration: SchemaMigration): boolean =>
			!sinceHLC || compareHLC(filingPosition(migration), sinceHLC) > 0;
		const dataChanges = sinceHLC
			? await this.collectChangesSince(this.changeLog.getChangesSince(sinceHLC), notFromPeer)
			: await this.collectAllChanges(peerSiteId);
		const migrations = await this.collectSchemaMigrations(
			migration => notFromPeer(migration.hlc) && filedAfter(migration),
		);

		return this.buildChangeSetsForPeer(peerSiteId, sinceHLC, dataChanges, migrations);
	}

	/**
	 * What this replica wrote after `sinceHLC`, which here is an ORIGIN timestamp: the
	 * sent watermark is the greatest `ChangeSet.hlc` the peer has acknowledged, and the
	 * sets returned are grouped by transaction and carry no `cursor`.
	 *
	 * The scan still starts after `sinceHLC` in the change log, which is ordered by
	 * filing position: a position is never below its fact's origin timestamp, so nothing
	 * written after `sinceHLC` sits before that point. The origin test is on each fact
	 * as well as its site: a replica restored from a snapshot holds its own earlier
	 * facts at the sender's positions, which are above its sent watermark for good, and
	 * without the test every handshake would push them again.
	 */
	async getChangesToPush(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
		const siteId = this.getSiteId();
		const ownAndUnsent = (origin: HLC): boolean =>
			siteIdEquals(origin.siteId, siteId) && (!sinceHLC || compareHLC(origin, sinceHLC) > 0);
		// NOTE: walks every change-log key past the watermark, and a device's sent
		// watermark does not move while it only receives: a quiet device walks the whole
		// log per handshake (keys only, no record reads), a rarely-writing one re-walks
		// what it received since its last write. If this shows up, persist a "scanned
		// through" position per peer.
		//
		// NOTE: the scan stops at a batch boundary in FILING order while the sent watermark
		// moves in ORIGIN order. The two agree for facts written here. A replica that was
		// restored from one peer's snapshot and then pushes its own restored facts to a
		// DIFFERENT peer reads them in the first peer's filing order, so a batch cut can
		// leave an older-origin fact behind the watermark, never pushed to the second peer.
		// `SyncClient` pushes to one server, which is where such facts came from. If a
		// replica ever pushes to two, scan its own restored facts in full before cutting.
		const log = sinceHLC ? this.changeLog.getChangesSince(sinceHLC) : this.changeLog.getAllChanges();
		const ownChanges = await this.collectChangesSince(log, ownAndUnsent);
		const ownMigrations = await this.collectSchemaMigrations(migration => ownAndUnsent(migration.hlc));

		// NOTE: nothing records which peer a held change came from, so a change held from
		// this same peer goes back to it once, until the sent watermark passes it. That
		// takes a device that retired a table the server still has, under the non-default
		// `store-and-forward` disposition. If it matters, record the source peer on the
		// quarantine entry.
		return this.buildChangeSetsForPeer(
			peerSiteId,
			sinceHLC,
			filedAtOrigin(ownChanges.map(filed => filed.change)),
			ownMigrations.map(({ position: _position, ...migration }) => migration),
		);
	}

	/**
	 * The shared tail of {@link getChangesSince} and {@link getChangesToPush}: add the
	 * held changes to forward, then group by transaction and filing tick and bound the
	 * result.
	 */
	private async buildChangeSetsForPeer(
		peerSiteId: SiteId,
		sinceHLC: HLC | undefined,
		dataChanges: FiledChange[],
		migrations: SchemaMigration[],
	): Promise<ChangeSet[]> {
		// Fold forwardable held changes (the `store-and-forward` relay's outbound
		// half) into the SAME ChangeSet[] return — no new transport surface. Each
		// keeps its ORIGINAL hlc + siteId. A held change was never filed here, so it has
		// no position of its own and is placed at its origin timestamp: it forms a
		// ChangeSet with the other held changes of its transaction, separate from any
		// part of that transaction this replica applied (which sits at the tick it was
		// filed at).
		//
		// BOUND + ORDERING (verify, no extra code): collectChangesSince early-exits its
		// change-log scan at a group cut C; collectForwardableChanges is FULLY scanned
		// (all `> sinceHLC`). buildTransactionChangeSets re-bounds the UNION at batchSize
		// at a group boundary M ≤ C. Everything placed ≤ M from BOTH sources is present
		// (change-log up to C ⊇ ≤ M; forwardable fully scanned ⊇ ≤ M), so advancing the
		// consumer's watermark to M skips nothing that was collected, and forwardable
		// entries placed in (M, …] are re-collected next round (still `> sinceHLC`).
		const forwardable = await this.collectForwardableChanges(peerSiteId, sinceHLC);
		const changes = forwardable.length > 0 ? [...dataChanges, ...filedAtOrigin(forwardable)] : dataChanges;

		return buildTransactionChangeSets(
			changes,
			migrations,
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

	/**
	 * Delta extraction: the facts in `logEntries` (a change-log scan, which is in filing
	 * order) from a wanted origin, bounded at **scan time** to whole groups whose
	 * cumulative data-change count reaches `batchSize`. A group is one transaction's
	 * facts filed at one tick (`change-grouping.ts`), the unit a `ChangeSet` carries.
	 *
	 * The origin check comes before the batch counter, so a run of unwanted entries
	 * spends no budget and cannot produce an empty result while wanted facts remain:
	 * an empty result always means nothing wanted is left.
	 *
	 * The scan can stop as soon as enough WHOLE groups have accumulated, instead of
	 * draining the entire iterator into memory and letting
	 * {@link buildTransactionChangeSets} truncate afterward, because of how facts are
	 * filed: a transaction written here takes one clock tick, and a batch received from
	 * elsewhere takes one tick in which each transaction's facts get a run of `opSeq`s to
	 * themselves (`commitChangeMetadata`). So in key order a group's facts are contiguous,
	 * and the group changes exactly when the entry's transaction or its tick does. A
	 * transaction alone is not a boundary test: two applies can each file part of one
	 * transaction, with other transactions' facts filed in between. The bound here
	 * mirrors the grouping step exactly — whole groups accumulate until the cumulative
	 * data-change count reaches `batchSize`, never splitting one — so the grouped
	 * response is identical; only the scan footprint shrinks.
	 *
	 * LOAD-BEARING INVARIANT: every entry that resolves to a change is keyed by that
	 * change's record's own filing position, and carries its origin timestamp. The
	 * boundary test here reads the entry; the grouper reads the same two values back
	 * through the {@link FiledChange} built from it. A reply's resume position is the
	 * greatest position it carries, so an entry that resolved to a record filed
	 * elsewhere would let that position pass facts the reply does not hold.
	 * {@link resolveLogEntry} enforces it by reading such an entry as stale, and the
	 * writers keep it true by removing a record's entry whenever the record is replaced:
	 *   - COLUMN: an overwrite deletes the prior `(pk, column)` entry (see
	 *     {@link recordColumnVersions} and `commitChangeMetadata`).
	 *   - DELETE: a newer tombstone deletes the prior `pk` delete entry (see
	 *     {@link recordDataEvent} and `commitChangeMetadata`), so a
	 *     delete→reinsert→delete key reuse leaves one entry, at the current tombstone.
	 *   - Both delete by the prior RECORD's position (`ChangeLogStore` takes the record,
	 *     not an HLC), which for a fact that arrived late is not its HLC.
	 *
	 * The overwrite dedup above covers entries written across SEPARATE writes/applies
	 * (each later one sees the prior committed version). The apply path additionally
	 * collapses in-batch repeats: two versions of one key inside a single
	 * `applyChanges` call resolve against the SAME pre-batch prior version, so neither
	 * sees the other — `commitChangeMetadata` keeps only the max-HLC winner per key and
	 * writes a single entry, preserving the invariant regardless of how many versions
	 * of a key were batched.
	 *
	 * (Schema migrations are still fully scanned by {@link collectSchemaMigrations};
	 * the `sm:` range is not in filing order, but migrations are few and the grouping
	 * step drops any filed past the bounded fact watermark.)
	 */
	private async collectChangesSince(
		logEntries: AsyncIterable<ChangeLogEntry>,
		isWantedOrigin: (origin: HLC) => boolean,
	): Promise<FiledChange[]> {
		const batchSize = this.config.batchSize;
		const changes: FiledChange[] = [];
		// Data-change count over fully-scanned (whole) groups. The in-flight group's
		// own count is held separately until its boundary is crossed, so it is only
		// folded in once the group is known to be complete.
		let completedChangeCount = 0;
		let currentGroup: string | null = null;
		let currentGroupChangeCount = 0;

		for await (const logEntry of logEntries) {
			// A transaction is wholly one site's, so filtering by origin drops whole
			// groups cleanly (no half-empty ChangeSet).
			if (!isWantedOrigin(logEntry.hlc)) continue;

			const group = filingGroupKey(logEntry);
			if (currentGroup !== null && group !== currentGroup) {
				completedChangeCount += currentGroupChangeCount;
				// Enough whole groups accumulated — stop before touching the next one.
				// buildTransactionChangeSets re-applies the same bound, so feeding it
				// this prefix yields the same ChangeSets the full scan would have.
				if (completedChangeCount >= batchSize) break;
				currentGroupChangeCount = 0;
			}
			currentGroup = group;

			const change = await this.resolveLogEntry(logEntry);
			if (!change) continue;
			changes.push({ change, position: logEntry.position });
			currentGroupChangeCount++;
		}
		return changes;
	}

	/**
	 * Resolve a change-log entry to the live {@link Change} it references, or
	 * `null` when the entry is stale: the underlying column version / tombstone is
	 * gone (a row deleted after the entry was written), the record now there is filed
	 * at another position (it was replaced and this entry was left behind), or the
	 * entry's table generation has been RETIRED (the table was dropped, and its
	 * records with it). A stale entry waits for {@link repairChangeLog}. The
	 * authoritative HLC, value AND pk come from the current version record, not the
	 * log key — the key carries only the lossy pk identity — and the change is
	 * addressed by the table's CURRENT name, which is how a fact recorded before a
	 * rename ships under the name the peer will know it by.
	 */
	private async resolveLogEntry(logEntry: ChangeLogEntry): Promise<Change | null> {
		const name = this.tableIdentity.nameOf(logEntry.generation);
		if (!name) return null;
		const filedHere = (record: { hlc: HLC; position?: HLC }): boolean =>
			compareHLC(filingPosition(record), logEntry.position) === 0;

		if (logEntry.entryType === 'column') {
			const cv = await this.columnVersions.getColumnVersionByIdentity(
				logEntry.generation,
				logEntry.identity,
				logEntry.column!,
			);
			if (!cv || !filedHere(cv)) return null;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: name.schema,
				table: name.table,
				pk: cv.pk,
				column: logEntry.column!,
				value: cv.value,
				hlc: cv.hlc,
				// Re-emit the stored before-image (spread only when present), so a
				// receiver/relay forwards the origin's prior chain unchanged.
				...(cv.priorHlc !== undefined ? { priorHlc: cv.priorHlc, priorValue: cv.priorValue } : {}),
			};
			return columnChange;
		}

		const tombstone = await this.tombstones.getTombstoneByIdentity(logEntry.generation, logEntry.identity);
		if (!tombstone || !filedHere(tombstone)) return null;

		const deletion: RowDeletion = {
			type: 'delete',
			schema: name.schema,
			table: name.table,
			pk: tombstone.pk,
			hlc: tombstone.hlc,
			// Re-emit the stored before-image (spread only when present) so a
			// receiver/relay forwards the origin's last-known row image unchanged.
			...(tombstone.priorRow !== undefined ? { priorRow: tombstone.priorRow } : {}),
		};
		return deletion;
	}

	/**
	 * Full extraction (initial sync / delta-from-zero): every column version and
	 * tombstone not originating from the peer, each with the position its record says
	 * it is filed at, so the reply is ordered and cut exactly as a change-log read would
	 * order and cut it and its watermark continues into one. Ordering is owned by
	 * {@link buildTransactionChangeSets}, so no pre-sort is needed here.
	 *
	 * Unlike {@link collectChangesSince}, this path cannot early-exit at scan time:
	 * the `cv:`/`tb:` scans are keyed by table/pk, NOT by position, so groups are
	 * interleaved arbitrarily and no group boundary is reachable without a
	 * full scan + sort. It is left unbounded because it is the from-zero path of a
	 * read serving a peer: a large initial range is expected to be served by a
	 * snapshot rather than this delta path (docs/sync.md). {@link getChangesToPush}
	 * has no such alternative and reads from zero through the change log instead.
	 *
	 * Records of a RETIRED generation (a dropped table's leftovers) are skipped:
	 * they describe an incarnation no peer should receive, and shipping a dropped
	 * table's tombstone would delete the row of its same-named successor.
	 */
	private async collectAllChanges(peerSiteId: SiteId): Promise<FiledChange[]> {
		const changes: FiledChange[] = [];

		const cvBounds = buildAllColumnVersionsScanBounds();
		for await (const entry of this.kv.iterate(cvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;
			const name = this.tableIdentity.nameOf(parsed.generation);
			if (!name) continue;

			const cv = deserializeColumnVersion(entry.value);
			if (siteIdEquals(cv.hlc.siteId, peerSiteId)) continue;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: name.schema,
				table: name.table,
				pk: cv.pk,
				column: parsed.column,
				value: cv.value,
				hlc: cv.hlc,
				...(cv.priorHlc !== undefined ? { priorHlc: cv.priorHlc, priorValue: cv.priorValue } : {}),
			};
			changes.push({ change: columnChange, position: filingPosition(cv) });
		}

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const parsed = parseTombstoneKey(entry.key);
			if (!parsed) continue;
			const name = this.tableIdentity.nameOf(parsed.generation);
			if (!name) continue;

			const tombstone = deserializeTombstone(entry.value);
			if (siteIdEquals(tombstone.hlc.siteId, peerSiteId)) continue;

			const deletion: RowDeletion = {
				type: 'delete',
				schema: name.schema,
				table: name.table,
				pk: tombstone.pk,
				hlc: tombstone.hlc,
				...(tombstone.priorRow !== undefined ? { priorRow: tombstone.priorRow } : {}),
			};
			changes.push({ change: deletion, position: filingPosition(tombstone) });
		}

		return changes;
	}

	/**
	 * Collect forwardable held changes to re-offer to a peer — the outbound half of
	 * the `store-and-forward` unknown-table disposition. Source is
	 * {@link QuarantineStore.listForwardable}: straggler changes this peer held
	 * because it has retired the table, marked forwardable. Each is re-offered with
	 * its ORIGINAL `hlc` + `siteId` (the straggler's fact, not a new local one) — the
	 * identity that makes the relay loop-free and convergent across hops with NO
	 * per-table peer-membership oracle (none exists): a peer that already holds the
	 * change re-holds it idempotently (HLC-keyed) and the per-peer watermark stops
	 * re-send after one exchange.
	 *
	 * Two filters, mirroring {@link collectChangesSince} / {@link collectAllChanges}:
	 *  - **Echo exclusion** — drop a change whose origin (`change.hlc.siteId`) is the
	 *    peer itself, so a straggler's fact is never echoed back to its own author.
	 *  - **Watermark filter** — when `sinceHLC` is defined (delta path), keep only
	 *    `compareHLC(change.hlc, sinceHLC) > 0`. A held change was never filed, so it
	 *    has no position here and is placed in the reply at its origin timestamp. On a
	 *    pull, `sinceHLC` is a filing position, which is at or above every origin
	 *    timestamp this replica had seen when it was issued; comparing the two filters
	 *    out more than a position would, and never lets a reply carry a change at or
	 *    below the watermark the consumer already holds. That matters because the
	 *    consumer moves its watermark to the reply's greatest resume position: a
	 *    change at or below the old watermark could not move it, and the same reply
	 *    would be served again on every request. When `sinceHLC` is undefined
	 *    (from-zero / {@link collectAllChanges} path) there is no lower bound, so all
	 *    (origin ≠ peer) are kept.
	 *
	 * Accepted limitation (documented intent, not a defect): a held change written
	 * before the peer's watermark (`HLC ≤ sinceHLC`) is NOT relayed via this delta
	 * path. This is a limit of held changes alone. A change this replica APPLIED is
	 * filed at the position it arrived at and reaches every peer however old it is; a
	 * held one has no arrival position to be read by. store-and-forward targets the
	 * transitional uneven-retirement window, where the straggler's writes are recent
	 * enough to exceed holder watermarks; quarantine already prevents write loss
	 * outside it.
	 *
	 * Snapshot carve-out: forwardable entries are DELTA-ONLY. The snapshot collectors
	 * scan only `cv:`/`tb:`/`sm:` (never `qt:`), since a snapshot transfers the
	 * offering peer's OWN basis and a forwarded change is for a table that peer does
	 * not have.
	 *
	 * Full horizon-bounded scan (no early-exit), paralleling {@link collectAllChanges}:
	 * the forwardable set is bounded by the retention horizon and is EMPTY — so this
	 * is zero-cost — in the no-straggler case.
	 */
	private async collectForwardableChanges(peerSiteId: SiteId, sinceHLC?: HLC): Promise<Change[]> {
		const held = await this.quarantine.listForwardable();
		const changes: Change[] = [];
		for (const entry of held) {
			const change = entry.change;
			// Echo exclusion: the change's HLC siteId is the straggler origin.
			if (siteIdEquals(change.hlc.siteId, peerSiteId)) continue;
			// Watermark filter on the delta path (see contract above).
			if (sinceHLC && compareHLC(change.hlc, sinceHLC) <= 0) continue;
			changes.push(change);
		}
		// Relay-activity telemetry: a held entry is counted on EVERY read that re-offers it
		// (repeatedly until GC), and the batch bound may defer some to
		// a later round (re-counted then) — so this measures relay ACTIVITY, not distinct
		// deliveries (distinct from the apply-time `forwarded` hold count).
		this.unknownTableRelayed += changes.length;
		return changes;
	}

	/**
	 * Collect the schema migrations `isWanted` keeps, each with the position it is
	 * filed at. A migration shares its transaction's base HLC and was filed in the
	 * same tick as that transaction's data facts, below them, so the grouping step
	 * rejoins it with them (or forms a DDL-only ChangeSet).
	 *
	 * The `sm:` range is keyed by `(schema, kind, object, version)`, not by position, so
	 * this read cannot early-exit the way {@link collectChangesSince} does — the whole
	 * range is drained even when the fact side stops early. That is acceptable because
	 * migrations are few, and {@link buildTransactionChangeSets} drops any migration
	 * filed past the bounded fact watermark (its group falls beyond the `batchSize`
	 * cut), so over-scanning here costs work but never correctness. A
	 * peer with a pathological volume of un-synced DDL is the one case this leaves
	 * unbounded; see the bounded-extraction ticket's handoff.
	 */
	private async collectSchemaMigrations(
		isWanted: (migration: SchemaMigration) => boolean,
	): Promise<SchemaMigration[]> {
		const all = await this.schemaMigrations.listAllMigrations();
		return all.filter(isWanted);
	}

	// ============================================================================
	// Delegated: Change Application
	// ============================================================================

	async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
		return this.trackApply(applyChangesImpl(this, changes));
	}

	async drainHeldChanges(schema?: string, table?: string): Promise<number> {
		return this.trackApply(drainHeldChangesImpl(this, schema, table));
	}

	async findTablesWithUnrecordedRows(): Promise<Array<{ schema: string; table: string }>> {
		return findTablesWithUnrecordedRowsImpl(this);
	}

	adoptUnrecordedRows(): Promise<AdoptedRows> {
		const adopting = this.adoptOnCommitChain();
		this.adoptionsInFlight = Promise.allSettled([this.adoptionsInFlight, adopting]).then(() => undefined);
		return adopting;
	}

	/**
	 * Run one adoption as one entry on the commit chain, ordering it with local capture.
	 *
	 * Applies in flight must finish BEFORE the entry joins the chain, not inside it: an
	 * apply writes rows before their records, so adoption would stamp a remote row as a
	 * local one, and an apply files its metadata as an entry on the chain too, so
	 * waiting for it from inside would deadlock. From the append on, a new apply queues
	 * behind this entry, because `applyChanges` waits on the chain first thing. No `await`
	 * may separate the wait below from the append.
	 *
	 * The caller receives a failure; the chain itself carries on.
	 */
	private async adoptOnCommitChain(): Promise<AdoptedRows> {
		await this.appliesDrained();
		return this.onCommitChain(() => withIdentityRecovery(
			this.tableIdentity,
			() => adoptUnrecordedRowsImpl(this, batch => this.recordCommitBatch(batch)),
		));
	}

	/**
	 * Resolves at a moment when no apply is in flight, rechecking for any that started during the wait.
	 *
	 * NOTE: an unbroken run of overlapping applies keeps this waiting. A client's broadcasts
	 * come in bursts, so it ends; if a busy server ever starves a first attach, stop admitting
	 * new applies here instead of rechecking.
	 */
	private async appliesDrained(): Promise<void> {
		let applies: Promise<void>;
		do {
			applies = this.appliesInFlight;
			await applies;
		} while (applies !== this.appliesInFlight);
	}

	async canDeltaSync(sinceHLC: HLC): Promise<boolean> {
		return this.deltaFloor.admits(sinceHLC);
	}

	async getDeltaFloor(): Promise<HLC | undefined> {
		return this.deltaFloor.get();
	}

	// ============================================================================
	// Delegated: Non-Streaming Snapshots
	// ============================================================================

	async getSnapshot(): Promise<Snapshot> {
		return getSnapshotImpl(this);
	}

	/**
	 * Waits for adoptions under way, as the streaming apply does. Clearing metadata under
	 * one would make every remaining row look unrecorded, and the records it then wrote
	 * would stand as this snapshot's own, keeping rows the snapshot should delete.
	 */
	async applySnapshot(snapshot: Snapshot): Promise<void> {
		await this.adoptionsInFlight;
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

	async updatePeerSentState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
		await this.peerStates.setPeerSentState(peerSiteId, hlc);
	}

	async getPeerSentState(peerSiteId: SiteId): Promise<HLC | undefined> {
		return this.peerStates.getPeerSentState(peerSiteId);
	}

	/**
	 * Drop tombstones past the retention horizon, together with the change-log
	 * `delete` entry each one backs. The entry is only an index pointer at the
	 * tombstone ({@link resolveLogEntry} returns null once the tombstone is gone),
	 * so leaving it would accumulate one dead entry per delete the replica has ever
	 * seen — the delete-side twin of the column cleanup in
	 * {@link deleteRowVersionsAndLogEntries}. Both deletions share this batch.
	 *
	 * A delete this replica has not delivered stays whatever its age, because its
	 * tombstone is what {@link getChangesToPush} sends (see {@link isUndeliveredOwnDelete}).
	 *
	 * The delta floor (`metadata/delta-floor.ts`) is raised to the greatest
	 * pruned tombstone's filing POSITION in this SAME batch: a peer whose watermark is
	 * below it can no longer be served a complete delta, and a crash between the
	 * deletes and the raise would let such a peer sync past the gap silently. The
	 * position, not the HLC: a delete that arrived late has an old HLC and a recent
	 * position, and a peer that has read past the HLC but not the position still needs it.
	 *
	 * NOTE: a replica that writes locally but never pushes (a `readOnly` client, a peer
	 * others only pull from, a device that never connects) keeps its own tombstones
	 * forever. The growth is one record per own delete, not measured. If that shows up,
	 * add a way for the host to declare the replica has no upstream.
	 */
	async pruneTombstones(): Promise<number> {
		const now = Date.now();
		let count = 0;
		const batch = this.kv.batch();
		let maxPrunedPosition: HLC | undefined;
		// Read once: each peer's watermark only rises, so a stale value keeps more, never less.
		const minSentWatermark = await this.peerStates.getMinSentWatermark();

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const tombstone = deserializeTombstone(entry.value);
			const expired = now - tombstone.createdAt > this.config.retentionHorizonMs;

			if (expired && !this.isUndeliveredOwnDelete(tombstone.hlc, minSentWatermark)) {
				batch.delete(entry.key);
				const position = filingPosition(tombstone);
				if (!maxPrunedPosition || compareHLC(position, maxPrunedPosition) > 0) {
					maxPrunedPosition = position;
				}
				const parsed = parseTombstoneKey(entry.key);
				if (parsed) {
					// Generation + identity delete: the parsed key already carries both, so
					// neither a name nor a schema (which a since-dropped table — a retired
					// generation — no longer has) is needed. Expired orphans prune too.
					this.changeLog.deleteEntryByIdentityBatch(batch, tombstone, 'delete', parsed.generation, parsed.identity);
				} else {
					console.warn('[Sync] Unparseable tombstone key during prune — its change-log entry is left orphaned');
				}
				count++;
			}
		}

		if (maxPrunedPosition) {
			await this.deltaFloor.raiseBatch(batch, maxPrunedPosition);
		}
		await batch.write();
		return count;
	}

	/**
	 * Whether a tombstone holds a delete some peer has yet to receive from this replica.
	 * Own tombstones only: {@link getChangesToPush} sends only what this replica wrote,
	 * and a replica that only receives never gets a sent watermark, so counting other
	 * devices' deletes would keep them forever on it. The comparison matches that read,
	 * which sends what is strictly after the watermark.
	 */
	private isUndeliveredOwnDelete(hlc: HLC, minSentWatermark: HLC | undefined): boolean {
		if (!siteIdEquals(hlc.siteId, this.getSiteId())) return false;
		return !minSentWatermark || compareHLC(hlc, minSentWatermark) > 0;
	}

	/**
	 * GC quarantined out-of-basis straggler changes past the retention horizon —
	 * the quarantine sibling of {@link pruneTombstones}, keyed off the same
	 * `retentionHorizonMs`. A held change older than the horizon was already
	 * outside the delivery guarantee.
	 *
	 * NOTE: unlike {@link pruneTombstones} this does NOT raise the delta floor.
	 * Held forwardable changes are not in snapshots either (docs/sync.md §
	 * Snapshot carve-out), so refusing a delta here would force a snapshot that
	 * lacks them just the same — the floor would cost a full copy and buy nothing.
	 */
	async pruneQuarantine(): Promise<number> {
		const cutoff = Date.now() - this.config.retentionHorizonMs;
		return this.quarantine.pruneOlderThan(cutoff);
	}

	/**
	 * One-shot repair pass over the whole change log: delete every entry whose
	 * target ({@link resolveLogEntry}) is already gone.
	 *
	 * {@link pruneTombstones} / `deleteRowVersionsAndLogEntries` (`sync-context.ts`)
	 * only stop *new* orphans — each deletes a `cl:` entry *via* the record it
	 * points at, so an entry whose record died before that forward fix landed can
	 * never be reached that way and is orphaned forever. This sweep reaches those
	 * by scanning the change log itself instead of a record's deletion path.
	 *
	 * Safe to run at any time, on any replica, with no peer coordination: an
	 * entry that resolves to `null` already produced no output for
	 * {@link collectChangesSince} (`resolveLogEntry` returning `null` is exactly
	 * what makes it an orphan), so deleting it changes nothing observable. That
	 * includes every entry of a RETIRED table generation: a drop deletes the table's
	 * `cv:`/`tb:` records ({@link TableIdentityStore.retire}) but leaves their index
	 * entries, which only a scan of the position-first log can find, to this sweep. Full
	 * scan, same shape as {@link pruneTombstones} — a replica with no pre-fix orphans
	 * (or one already repaired) resolves every entry and deletes nothing, so a
	 * caught-up replica pays only the scan.
	 *
	 * NOTE: the scan is one KV point-read per change-log entry, and the log holds
	 * roughly one entry per live cell, so a caught-up replica still pays O(live
	 * cells) reads on every maintenance tick for a repair that can only ever find
	 * something once. If that cost shows up (large replica, 5-minute quoomb-web
	 * cadence), stop re-scanning after a clean pass — see
	 * `debt-sync-repair-changelog-rescans-every-tick`.
	 *
	 * NOTE: entries whose key `parseChangeLogKey` cannot decode are skipped by
	 * `getAllChanges`, so this sweep cannot reach them either. Only reachable via
	 * key-format drift or corruption; if that ever happens, repair needs to iterate
	 * raw `cl:` keys rather than parsed entries.
	 */
	async repairChangeLog(): Promise<number> {
		const batch = this.kv.batch();
		let count = 0;

		for await (const logEntry of this.changeLog.getAllChanges()) {
			const resolved = await this.resolveLogEntry(logEntry);
			if (resolved) continue;

			this.changeLog.deleteEntryByIdentityBatch(
				batch,
				logEntry,
				logEntry.entryType,
				logEntry.generation,
				logEntry.identity,
				logEntry.column,
			);
			count++;
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
		await this.adoptionsInFlight; // See applySnapshot.
		// Every flush stages identity transitions and lazy mints; a mid-stream throw
		// must not leave the index ahead of what committed.
		return withIdentityRecovery(this.tableIdentity, () => applySnapshotStreamImpl(this, chunks, onProgress));
	}

	async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
		return getSnapshotCheckpointImpl(this, snapshotId);
	}

	async listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]> {
		return listSnapshotCheckpointsImpl(this);
	}

	async clearSnapshotCheckpoint(snapshotId: string): Promise<void> {
		return clearSnapshotCheckpointImpl(this, snapshotId);
	}

	async *resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {
		yield* resumeSnapshotStreamImpl(this, checkpoint);
	}
}
