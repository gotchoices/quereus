/**
 * Sync Plugin for Quereus
 *
 * Provides multi-master CRDT replication with automatic conflict resolution.
 *
 * Features:
 * - Fully automatic: All tables are CRDT-enabled without opt-in
 * - Column-level LWW: Fine-grained conflict resolution
 * - Transport agnostic: Bring your own WebSocket/HTTP/WebRTC
 * - Reactive hooks: UI integration for real-time updates
 * - Offline-first: Works with local changes that sync later
 *
 * Usage:
 *   import { createSyncModule } from '@quereus/sync';
 *   import { LevelDBStore } from '@quereus/store';
 *
 *   const kv = await LevelDBStore.open({ path: './sync-metadata' });
 *   // `db` is the engine Database; it captures local changes at the
 *   // transaction boundary. Omit transactionSource for a relay-only deployment.
 *   const { syncManager, syncEvents } = await createSyncModule(kv, { transactionSource: db });
 */

// Clock module
export {
  // HLC types and functions
  type HLC,
  HLCManager,
  compareHLC,
  hlcEquals,
  maxHLC,
  createHLC,
  deterministicTxnId,
  MAX_OPSEQ,
  serializeHLC,
  deserializeHLC,
  // HLC JSON serialization (for schema seeds and transport)
  type SerializedHLC,
  hlcToJson,
  hlcFromJson,
  // Site ID types and functions
  type SiteId,
  generateSiteId,
  // Base64url encoding
  siteIdToBase64,
  siteIdFromBase64,
  toBase64Url,
  fromBase64Url,
  siteIdEquals,
  type SiteIdentity,
  serializeSiteIdentity,
  deserializeSiteIdentity,
  SITE_ID_KEY,
} from './clock/index.js';

// Sync protocol types
export {
  // Change types
  type ColumnChange,
  type RowDeletion,
  type Change,
  // Schema types
  type SchemaMigrationType,
  type SchemaMigration,
  // Transaction types
  type ChangeSet,
  // API types
  type ApplyRejection,
  type ApplyResult,
  type ColumnVersionEntry,
  type TableSnapshot,
  type Snapshot,
  type PeerSyncState,
  // Streaming snapshot types
  type SnapshotChunkType,
  type SnapshotHeaderChunk,
  type SnapshotTableStartChunk,
  type SnapshotColumnVersionsChunk,
  type SnapshotTableEndChunk,
  type SnapshotSchemaMigrationChunk,
  type SnapshotFooterChunk,
  type SnapshotChunk,
  type SnapshotProgress,
  // Apply-to-store callback types
  type ApplyToStoreOptions,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type ApplyToStoreResult,
  type ApplyToStoreCallback,
  // Conflict resolution
  type ConflictContext,
  type ConflictResolution,
  type ConflictResolver,
  // Configuration
  type SyncConfig,
  DEFAULT_SYNC_CONFIG,
} from './sync/protocol.js';

// Built-in conflict resolvers
export {
  lwwResolver,
  localWinsResolver,
  remoteWinsResolver,
} from './sync/conflict-resolvers.js';

// Sync manager
export { type SyncManager, type SnapshotCheckpoint } from './sync/manager.js';
export { SyncManagerImpl } from './sync/sync-manager-impl.js';

// Store adapter for applying remote changes
export { createStoreAdapter, type SyncStoreAdapterOptions } from './sync/store-adapter.js';

// Factory function
export {
  createSyncModule,
  type CreateSyncModuleResult,
  type CreateSyncModuleOptions,
  type GetTableSchemaCallback,
  type TransactionCommitSource,
} from './create-sync-module.js';

// Reactive events
export {
  type RemoteChangeEvent,
  type LocalChangeEvent,
  type ConflictEvent,
  type SyncState,
  type Unsubscribe,
  type SyncEventEmitter,
  SyncEventEmitterImpl,
} from './sync/events.js';

// Metadata storage
export {
  // Key builders
  SYNC_KEY_PREFIX,
  buildColumnVersionKey,
  buildTombstoneKey,
  buildTransactionKey,
  buildPeerStateKey,
  buildSchemaMigrationKey,
  buildColumnVersionScanBounds,
  buildTableColumnVersionScanBounds,
  buildTombstoneScanBounds,
  buildSchemaMigrationScanBounds,
  encodePK,
  decodePK,
  // Column versions
  type ColumnVersion,
  ColumnVersionStore,
  serializeColumnVersion,
  deserializeColumnVersion,
  // SqlValue JSON encoding (for Uint8Array/bigint in JSON transport)
  encodeSqlValue,
  decodeSqlValue,
  // Tombstones
  type Tombstone,
  TombstoneStore,
  serializeTombstone,
  deserializeTombstone,
  // Peer state
  type PeerState,
  PeerStateStore,
  serializePeerState,
  deserializePeerState,
  // Schema versions (column-level)
  type SchemaVersion,
  type SchemaVersionType,
  type SchemaChangeOperation,
  SchemaVersionStore,
  buildSchemaVersionKey,
  buildSchemaVersionScanBounds,
  buildAllSchemaVersionsScanBounds,
  serializeSchemaVersion,
  deserializeSchemaVersion,
  parseSchemaVersionKey,
  // Most destructive wins
  getDestructiveness,
  getOperationDestructiveness,
  shouldApplySchemaChangeByOperation,
} from './metadata/index.js';

