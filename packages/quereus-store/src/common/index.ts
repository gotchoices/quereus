/**
 * Common utilities for the persistent store module.
 */

// KV Store interface
export type {
  KVStore,
  KVEntry,
  WriteBatch,
  BatchOp,
  IterateOptions,
  KVStoreFactory,
  KVStoreOptions,
  KVStoreProvider,
} from './kv-store.js';

// Key encoding
export {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  registerCollationEncoder,
  getCollationEncoder,
  type CollationEncoder,
  type EncodeOptions,
} from './encoding.js';

// Row serialization
export {
  serializeRow,
  deserializeRow,
  serializeValue,
  deserializeValue,
  serializeStats,
  deserializeStats,
  type TableStats,
} from './serialization.js';

// Key building - new API
export {
	STORE_SUFFIX,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
	buildDataStoreName,
	buildIndexStoreName,
	buildStatsStoreName,
	buildStatsKey,
	buildDataKey,
	buildIndexKey,
	buildCatalogKey,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	classifyCatalogKey,
	type CatalogEntryKind,
	buildFullScanBounds,
	buildIndexPrefixBounds,
	buildCatalogScanBounds,
	// Legacy exports (deprecated)
	KEY_PREFIX,
	buildTablePrefix,
	buildTableScanBounds,
	buildIndexScanBounds,
	buildMetaKey,
	buildMetaScanBounds,
} from './key-builder.js';

// Events
export {
  StoreEventEmitter,
  type SchemaChangeEvent,
  type DataChangeEvent,
  type SchemaChangeListener,
  type DataChangeListener,
} from './events.js';

// DDL generation (canonical implementation lives in @quereus/quereus)
export { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaterializedViewDDL, generateIndexTagsDDL } from '@quereus/quereus';

// Transaction support
export {
  TransactionCoordinator,
  type TransactionCallbacks,
} from './transaction.js';

// In-memory KV store
export { InMemoryKVStore } from './memory-store.js';

// Cached KV store wrapper
export { CachedKVStore, type CacheOptions } from './cached-kv-store.js';

// Generic store table and connection
export {
  StoreTable,
  resolvePkKeyCollations,
  type StoreTableConfig,
  type StoreTableModule,
} from './store-table.js';
export { StoreConnection } from './store-connection.js';

// Generic store module
export { StoreModule, type StoreModuleConfig, type RehydrationResult, type RehydrationError } from './store-module.js';

// Isolation layer utilities
export {
	createIsolatedStoreModule,
	hasIsolation,
	type IsolatedStoreModuleConfig,
} from './isolated-store.js';
