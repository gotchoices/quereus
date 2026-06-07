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
- **Catalog keys**: `{schema}.{table}` as string

This design eliminates redundant prefixes and groups related stores together by table name.

**Catalog DDL is re-persisted on catalog-only tag swaps.** `ALTER … SET TAGS` (and the programmatic `setTableTags` / `setColumnTags` / `setConstraintTags`) never reach `alterTable`, so the module subscribes to the engine's `table_modified` events and re-writes the `__catalog__` entry when `generateTableDDL` output changes — table / column / named-constraint tags survive close → reopen. These async writes are serialized and drained by `closeAll()` (or the `whenCatalogPersisted()` barrier) before the provider closes. Index and view/MV tag persistence is still pending (see backlog tickets `store-secondary-index-persistence` / `store-view-mv-persistence`), since the catalog persists neither index nor view/MV DDL.

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
  
  // Optional: Delete stores
  deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;
  deleteTableStores?(schemaName: string, tableName: string): Promise<void>;

  // Optional: Relocate a table's data + index stores for ALTER TABLE ... RENAME TO
  renameTableStores?(schemaName: string, oldName: string, newName: string): Promise<void>;
}
```

## Module Capabilities

The `StoreModule` reports its capabilities via `getCapabilities()`:

```typescript
const storeModule = new StoreModule(provider);
const caps = storeModule.getCapabilities();

// {
//   isolation: false,      // Store module does NOT provide transaction isolation
//   savepoints: false,     // No savepoint support without isolation layer
//   persistent: true,      // Data persists across restarts
//   secondaryIndexes: true,// Supports secondary indexes
//   rangeScans: true       // Supports range scans
// }
```

**Important:** The base `StoreModule` does not provide transaction isolation. Without isolation:
- Reads see only committed data (no read-your-own-writes within a transaction)
- Concurrent readers may see partial writes
- Savepoints are not supported

## Transaction Isolation

To add full ACID transaction semantics with read-your-own-writes, wrap the store module with the `IsolationModule`:

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
| `buildCatalogKey` | Build key for catalog metadata |
| `buildFullScanBounds` | Build bounds for full table scan |
| `buildIndexPrefixBounds` | Build bounds for index prefix scan |
| `buildCatalogScanBounds` | Build bounds for catalog scan |
| `CATALOG_STORE_NAME` | Reserved catalog store name constant |
| `STORE_SUFFIX` | Store name suffixes (INDEX, STATS) |

## Related Packages

- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB implementation for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB implementation for browsers
- [`@quereus/sync`](../quereus-sync/) - CRDT sync layer

## License

MIT
