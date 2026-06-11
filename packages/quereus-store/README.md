# @quereus/store

Abstract key-value storage module for [Quereus](https://github.com/gotchoices/quereus). Provides platform-agnostic interfaces and a generic `StoreModule` virtual table implementation.

## Architecture

This package provides the **abstract layer** that separates virtual table logic from platform-specific storage:

```
@quereus/store (this package)
├── KVStore interface           - Abstract key-value store
├── KVStoreProvider interface   - Store factory/management
├── StoreModule                 - Generic VirtualTableModule
├── StoreTable                  - Generic virtual table implementation
├── StoreConnection             - Generic transaction support
└── Common utilities            - Encoding, serialization, events

@quereus/plugin-leveldb (Node.js)     @quereus/plugin-indexeddb (Browser)
├── LevelDBStore                      ├── IndexedDBStore
├── LevelDBProvider                   ├── IndexedDBProvider
└── Plugin registration               ├── IndexedDBManager
                                      └── CrossTabSync
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for IndexedDB, LevelDB, LMDB, or other "NoSQL" stores
- **Dependency injection** - Use `KVStoreProvider` for store management

## Storage Architecture

The store module uses separate logical stores for different data types:

**Store Naming Convention:**
- `{schema}.{table}` - Data store (row data)
- `{schema}.{table}_idx_{indexName}` - Index stores (one per secondary index)
- `{prefix}.__stats__` - Unified stats store (row counts for all tables)
- `__catalog__` - Catalog store (DDL metadata)

**Key Formats:**
- **Data keys**: Encoded primary key (no prefix)
- **Index keys**: Encoded index columns + encoded PK
- **Catalog keys**:
  - Tables: `{schema}.{table}` as a string (the `CREATE TABLE` bundle, with its index DDL and any exposed-implicit-index tag DDL)
  - Views: `\x00view\x00{schema}.{view}` (reserved-prefix; `generateViewDDL`)
  - Materialized views: `\x00mview\x00{schema}.{mv}` (reserved-prefix; `generateMaterializedViewDDL`)

This design eliminates redundant prefixes and groups related stores together by table name. The leading-`0x00` view/MV prefixes never collide with an unprefixed table key, so a view/MV may safely share a name with a table; a full catalog scan returns all three kinds intermixed and rehydrate classifies each by its key prefix.

**Catalog DDL is re-persisted on catalog-only mutations.** `ALTER … SET TAGS` (and the programmatic `setTableTags` / `setColumnTags` / `setConstraintTags` / `setViewTags` / `setMaterializedViewTags`), plus `CREATE`/`DROP VIEW` and `CREATE`/`DROP MATERIALIZED VIEW`, never reach `module.alterTable`/`module.destroy`. The module subscribes to the engine's schema-change events (`table_modified`, the `view_*` events, and the `materialized_view_*` events) and writes the matching `__catalog__` entry when its `generate*DDL` output changes — table / column / constraint / **index** / **view** / **materialized-view** tags, and view/MV lifecycle, all survive close → reopen. A table's bundle is its `CREATE TABLE` DDL, one `CREATE [UNIQUE] INDEX` line per secondary index, and one trailing `alter index … set tags (…)` line per *exposed implicit index* carrying user tags (an exposed implicit index is never materialized in store mode, so its `UniqueConstraintSchema.exposedIndexTags` has no `CREATE INDEX` line to ride; the alter line re-applies silently on import). These async writes are serialized and drained by `closeAll()` (or the `whenCatalogPersisted()` barrier) before the provider closes. On reopen, `rehydrateCatalog` classifies entries by key prefix and imports them in phases — tables → views → materialized views, all through the engine's `importCatalog` (MVs re-materialize silently via the shared create core, dependency-ordered for MV-over-MV by fixpoint retry). See [`docs/schema.md`](../../docs/schema.md#view-and-materialized-view-persistence) for the full design.

## Installation

```bash
npm install @quereus/store
```

For platform-specific implementations:
```bash
# Node.js
npm install @quereus/plugin-leveldb

# Browser
npm install @quereus/plugin-indexeddb
```

## Usage

### With a Provider

```typescript
import { Database } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';
// OR: import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';

const db = new Database();

// Create provider for your platform
const provider = createLevelDBProvider({ basePath: './data' });

// Create the generic store module with your provider
const storeModule = new StoreModule(provider);
db.registerModule('store', storeModule);

// Use it in SQL
await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

### Custom Storage Backend

Implement `KVStore` and `KVStoreProvider` to create custom storage backends:

```typescript
import type { KVStore, KVStoreProvider } from '@quereus/store';

class MyCustomStore implements KVStore {
  async get(key: Uint8Array) { /* ... */ }
  async put(key: Uint8Array, value: Uint8Array) { /* ... */ }
  async delete(key: Uint8Array) { /* ... */ }
  async has(key: Uint8Array) { /* ... */ }
  iterate(options?: IterateOptions) { /* ... */ }
  batch() { /* ... */ }
  async close() { /* ... */ }
  async approximateCount(options?: IterateOptions) { /* ... */ }
}

class MyCustomProvider implements KVStoreProvider {
  async getStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getIndexStore(schemaName: string, tableName: string, indexName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getStatsStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getCatalogStore() { /* ... */ }
  async closeStore(schemaName: string, tableName: string) { /* ... */ }
  async closeIndexStore(schemaName: string, tableName: string, indexName: string) { /* ... */ }
  async closeAll() { /* ... */ }
}

// Use it with StoreModule
const provider = new MyCustomProvider();
const module = new StoreModule(provider);
db.registerModule('store', module);
```

## KVStore Interface

The `KVStore` interface is the foundation for all storage backends:

```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  has(key: Uint8Array): Promise<boolean>;
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;
  batch(): WriteBatch;
  close(): Promise<void>;
  approximateCount(options?: IterateOptions): Promise<number>;
}

interface KVStoreProvider {
  // Get data store for a table
  getStore(schemaName: string, tableName: string): Promise<KVStore>;
  
  // Get index store for a secondary index
  getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
  
  // Get stats store for table statistics
  getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
  
  // Get catalog store for DDL metadata
  getCatalogStore(): Promise<KVStore>;
  
  // Close specific stores
  closeStore(schemaName: string, tableName: string): Promise<void>;
  closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void>;
  closeAll(): Promise<void>;
  
  // Optional: Delete stores. `indexNames` is the table's exact secondary-index
  // names (from the schema) — build index store names from it via
  // buildIndexStoreName instead of prefix-scanning `{table}_idx_`, which would
  // also match a sibling table literally named `{table}_idx_<x>`.
  deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;
  deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;

  // Optional: Relocate a table's data + index stores for ALTER TABLE ... RENAME TO
  // (`indexNames` carries the same authoritative, exact index list).
  renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;
}
```

## Module Capabilities

The `StoreModule` reports its capabilities via `getCapabilities()`:

```typescript
const storeModule = new StoreModule(provider);
const caps = storeModule.getCapabilities();

// {
//   isolation: false,      // Store module does NOT provide transaction isolation
//   savepoints: true,      // Coordinator-buffered ops support savepoints within a transaction
//   persistent: true,      // Data persists across restarts
//   secondaryIndexes: true,// Supports secondary indexes
//   rangeScans: true       // Supports range scans
// }
```

**Important:** The base `StoreModule` does not provide transaction isolation:
- No snapshot isolation: between connections, reads see only committed data, and concurrent readers may observe partial writes
- Within a transaction, reads through the table's shared coordinator DO see that transaction's own pending writes (read-your-own-writes)
- Savepoints (create / release / rollback-to) work within a transaction via the coordinator's buffered op log

## Materialized-View Backing Host

The store module implements the engine's backing-host capability
(`StoreBackingHost`), so `create materialized view mv using store as <body>`
places the MV's backing table in persistent storage. Maintenance writes ride
the per-table `TransactionCoordinator`'s pending state (committing/rolling back
in lockstep with the source write), mid-transaction reads of the MV see pending
maintenance through the read-your-own-writes merge, and the backing's text
primary-key columns are keyed under the store's `collation` arg (default
`NOCASE` — pass `using store(collation = 'BINARY')` for byte-exact keys). The
isolation wrapper forwards the capability automatically. See
[`docs/materialized-views.md` § The store host](../../docs/materialized-views.md#the-store-host-using-store).

## Transaction Isolation

To add full ACID transaction semantics with snapshot isolation, wrap the store module with the `IsolationModule`:

```typescript
import { Database, MemoryTableModule } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const db = new Database();
const provider = createLevelDBProvider({ basePath: './data' });

// Option 1: Use the convenience function
const isolatedModule = createIsolatedStoreModule({ provider });
db.registerModule('store', isolatedModule);

// Option 2: Manual wrapping for more control
const storeModule = new StoreModule(provider);
const isolatedModule = new IsolationModule({
	underlying: storeModule,
	overlay: new MemoryTableModule(),
});
db.registerModule('store', isolatedModule);

// Now transactions have full isolation
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

// Read-your-own-writes: sees uncommitted insert
const user = await db.get('SELECT * FROM users WHERE id = 1');
console.log(user.name); // 'Alice'

await db.exec('COMMIT'); // Or ROLLBACK to discard
```

The isolation layer provides:
- **Read-your-own-writes** within transactions
- **Snapshot isolation** for consistent reads
- **Savepoint support** via the overlay module

### Checking for Isolation Support

```typescript
import { hasIsolation } from '@quereus/store';

const storeModule = new StoreModule(provider);
console.log(hasIsolation(storeModule)); // false

const isolatedModule = createIsolatedStoreModule({ provider });
console.log(hasIsolation(isolatedModule)); // true
```

## API

### Core Exports

| Export | Description |
|--------|-------------|
| `KVStore` | Key-value store interface (type) |
| `KVStoreProvider` | Store factory interface (type) |
| `WriteBatch` | Batch write interface (type) |
| `IterateOptions` | Iteration options (type) |
| `StoreModule` | Generic VirtualTableModule |
| `StoreTable` | Virtual table implementation |
| `resolvePkKeyCollations` | Per-PK-column key collations (pass to `buildDataKey`/`buildIndexKey` to match `StoreTable`'s key bytes) |
| `StoreConnection` | Transaction connection |
| `TransactionCoordinator` | Transaction management |
| `StoreEventEmitter` | Event system for data/schema changes |

### Isolation Layer Utilities

| Export | Description |
|--------|-------------|
| `createIsolatedStoreModule` | Create store module with isolation layer |
| `hasIsolation` | Check if a module has isolation capability |
| `IsolatedStoreModuleConfig` | Configuration for isolated store module |

### Caching

| Export | Description |
|--------|-------------|
| `CachedKVStore` | Read-through LRU cache wrapper for any `KVStore` |
| `CacheOptions` | Configuration for cache (maxEntries, maxBytes, enabled) |

### Encoding Utilities

| Export | Description |
|--------|-------------|
| `encodeValue` | Encode a SQL value to sortable bytes |
| `decodeValue` | Decode bytes back to SQL value |
| `encodeCompositeKey` | Encode multiple values as composite key |
| `decodeCompositeKey` | Decode composite key to values |
| `registerCollationEncoder` | Register custom collation |

### Serialization Utilities

| Export | Description |
|--------|-------------|
| `serializeRow` | Serialize a row to bytes |
| `deserializeRow` | Deserialize bytes to row |
| `serializeValue` | Serialize a single value |
| `deserializeValue` | Deserialize a single value |

### Key Building

| Export | Description |
|--------|-------------|
| `buildDataStoreName` | Build store name for table data |
| `buildIndexStoreName` | Build store name for an index |
| `buildStatsStoreName` | Build store name for table stats |
| `buildDataKey` | Build key for row data (encoded PK) |
| `buildIndexKey` | Build key for index entry |
| `buildCatalogKey` | Build key for a table's catalog entry (`{schema}.{table}`) |
| `buildViewCatalogKey` | Build key for a view's catalog entry (reserved `\x00view\x00` prefix) |
| `buildMaterializedViewCatalogKey` | Build key for an MV's catalog entry (reserved `\x00mview\x00` prefix) |
| `classifyCatalogKey` | Classify a loaded catalog key as `'table'` / `'view'` / `'materializedView'` |
| `buildFullScanBounds` | Build bounds for full table scan |
| `buildIndexPrefixBounds` | Build bounds for index prefix scan |
| `buildPkPrefixBounds` | Build bounds for a data-store PK prefix range (per-column DESC + key collations) |
| `buildCatalogScanBounds` | Build bounds for catalog scan |
| `CATALOG_STORE_NAME` | Reserved catalog store name constant |
| `STORE_SUFFIX` | Store name suffixes (INDEX, STATS) |

## Related Packages

- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB implementation for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB implementation for browsers
- [`@quereus/sync`](../quereus-sync/) - CRDT sync layer

## License

MIT
