# Persistent Store Module Design

This document describes the design and architecture for the Quereus storage system:
- `@quereus/store` - Core storage module (StoreModule, StoreTable, utilities)
- `@quereus/plugin-leveldb` - LevelDB plugin for Node.js
- `@quereus/plugin-indexeddb` - IndexedDB plugin for browsers

## Storage Architecture

The store module uses a **multi-store architecture** where different types of data are stored in separate logical stores:

- **Data stores**: `{schema}.{table}` - One per table, containing row data keyed by encoded primary key
- **Index stores**: `{schema}.{table}_idx_{indexName}` - One per secondary index, containing index entries
- **Stats store**: `__stats__` - Single unified store containing row count and metadata for all tables, keyed by `{schema}.{table}`
- **Catalog store**: `__catalog__` - Single store containing DDL for all tables

## Reactive Hooks

The store module exposes reactive JavaScript hooks for schema and data changes, enabling UI updates, caching invalidation, and real-time synchronization.

### Schema Change Hooks

```typescript
interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index';
  schemaName: string;
  objectName: string;
  ddl?: string;  // For create/alter
}

store.onSchemaChange((event: SchemaChangeEvent) => {
  console.log(`${event.type} ${event.objectType}: ${event.schemaName}.${event.objectName}`);
});
```

### Data Change Hooks

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];      // Primary key values
  oldRow?: Row;         // For update/delete
  newRow?: Row;         // For insert/update
}

store.onDataChange((event: DataChangeEvent) => {
  // Invalidate cache, update UI, replicate, etc.
});
```

### Use Cases

- **UI Reactivity**: Update views when underlying data changes
- **Cache Invalidation**: Clear or update cached query results
- **Replication**: Stream changes to remote systems
- **Audit Logging**: Record all mutations with full context
- **Cross-Tab Sync**: Notify other browser tabs of changes (IndexedDB)

### StoreEventEmitter API

The `StoreEventEmitter` class provides the reactive hooks infrastructure and implements the `VTableEventEmitter` interface for compatibility with the core vtab event system:

```typescript
import { StoreEventEmitter } from '@quereus/store';
import type { VTableEventEmitter } from '@quereus/quereus';

// Create emitter and pass to module constructor
const eventEmitter = new StoreEventEmitter();
const module = new StoreModule(provider, eventEmitter);

// StoreEventEmitter is compatible with VTableEventEmitter
const vtabEmitter: VTableEventEmitter = eventEmitter;

// Subscribe to schema changes
const unsubscribeSchema = eventEmitter.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
  if (event.ddl) console.log('DDL:', event.ddl);
});

// Subscribe to data changes
const unsubscribeData = eventEmitter.onDataChange((event) => {
  console.log(`${event.type} on ${event.tableName}, key:`, event.key);
});

// Unsubscribe when done
unsubscribeSchema();
unsubscribeData();
```

### Cross-Tab Notifications (IndexedDB)

In browser environments, multiple tabs may share the same IndexedDB database. The `IndexedDBModule` uses `BroadcastChannel` to propagate `DataChangeEvent` across tabs:

```typescript
// Tab A makes a change
await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Event fires in Tab A via local emitter
// Event also broadcasts to other tabs

// Tab B receives the event
eventEmitter.onDataChange((event) => {
  // Fires for both local AND remote changes
  console.log(`${event.type} in ${event.tableName}`);
});
```

Events received from other tabs have `event.remote = true` to distinguish them from local changes.

## Overview

The store module provides persistent table storage while maintaining Quereus's key-based addressing model. The architecture uses a **platform abstraction layer** that separates core virtual table logic from platform-specific storage backends.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    @quereus/store (core)                      │
├──────────────────────────────────────────────────────────────┤
│  Interfaces                                                   │
│  ┌─────────────────┐  ┌─────────────────────────────────┐    │
│  │ KVStore         │  │ KVStoreProvider                  │    │
│  │ - get/put/delete│  │ - getStore(schema, table)       │    │
│  │ - iterate/batch │  │ - getCatalogStore()             │    │
│  └─────────────────┘  │ - closeStore/closeAll           │    │
│                       └─────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│  Generic Virtual Table                                        │
│  ┌─────────────────┐  ┌─────────────────────────────────┐    │
│  │ StoreTable      │  │ StoreConnection                  │    │
│  │ - query/update  │  │ - begin/commit/rollback         │    │
│  │ - getBestPlan   │  │ - savepoints                    │    │
│  └─────────────────┘  └─────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│  Common Utilities                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ Key Encoder │  │ Row Serial. │  │ TransactionCoord.   │   │
│  │ (sort-safe) │  │ (ext. JSON) │  │ - multi-table atomic│   │
│  └─────────────┘  └─────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│ @quereus/plugin-leveldb │     │ @quereus/plugin-indexeddb   │
├─────────────────────────┤     ├─────────────────────────────┤
│ LevelDBStore            │     │ IndexedDBStore              │
│ LevelDBProvider         │     │ IndexedDBProvider           │
│ - uses classic-level    │     │ - uses native IndexedDB API │
│ - Node.js only          │     │ - CrossTabSync              │
└─────────────────────────┘     │ - Browser only              │
                                └─────────────────────────────┘
```

### Key Interfaces

**KVStore** - Abstract key-value store interface:
```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  has(key: Uint8Array): Promise<boolean>;
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;
  batch(): WriteBatch;
  close(): Promise<void>;
}
```

**KVStoreProvider** - Factory for platform-specific stores:
```typescript
interface KVStoreProvider {
  // Get data store for a table
  getStore(schemaName: string, tableName: string, options?: StoreOptions): Promise<KVStore>;
  
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
  // names (from the schema); build index store names from it via
  // buildIndexStoreName rather than prefix-scanning `{table}_idx_`, which also
  // matches a sibling table literally named `{table}_idx_<x>`.
  deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;
  deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;

  // Optional: Relocate a table's data + index stores for ALTER TABLE ... RENAME TO
  // (`indexNames` carries the same authoritative, exact index list).
  renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;
}
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for SQLite, LMDB, or cloud storage
- **Dependency injection** - Use `KVStoreProvider` for store management

## Storage Layout

### Store Naming Convention

The module uses separate logical stores for different data types:

| Store Name | Purpose | Examples |
|------------|---------|----------|
| `{schema}.{table}` | Table data | `main.users`, `main.orders` |
| `{schema}.{table}_idx_{name}` | Secondary indexes | `main.users_idx_email` |
| `__stats__` | All table statistics | Single unified store |
| `__catalog__` | DDL metadata | Single catalog store |

**Benefits:**
- Clean grouping by table name (all stores for a table appear together)
- Each index gets its own store (no prefix required in keys)
- Shorter keys (no redundant schema.table prefixes)
- Simpler iteration (no prefix filtering needed)
- Unified stats store eliminates late database upgrades for stats

### Key Formats

**Data Keys** (in `{schema}.{table}` store):
- Format: Encoded primary key (no prefix)
- Example: For `users` table with PK `id=42`, key is just the encoded `42`

**Index Keys** (in `{schema}.{table}_idx_{name}` stores):
- Format: Encoded index columns + encoded PK
- Example: For email index, key is `encoded("alice@example.com") + encoded(42)`

**Catalog Keys** (in `__catalog__` store):
- Format: `{schema}.{table}` as UTF-8 string
- Value: DDL statement for table creation
- Example: Key `main.users` → `CREATE TABLE main.users (...)`

**Stats Keys** (in `__stats__` store):
- Format: `{schema}.{table}` as UTF-8 string
- Value: JSON `{rowCount: number, updatedAt: timestamp}`
- Example: Key `main.users` → `{"rowCount": 1000, "updatedAt": 1704067200000}`

### Primary Key Encoding

Composite keys are encoded to preserve lexicographic sort order:

- `0x00` - NULL
- `0x01` + 8-byte big-endian signed int (with sign flip for ordering)
- `0x02` + IEEE 754 double (with sign flip)
- `0x03` + UTF-8 bytes + `0x00` terminator (escaped internal nulls)
- `0x04` + length-prefixed bytes (BLOB)

### Row Serialization

Rows are stored as values using Quereus's extended JSON serializer, which handles:
- `bigint` via `{"$bigint": "12345..."}`
- `Uint8Array` via `{"$blob": "base64..."}`
- Standard JSON types

## Secondary Indexes

Indexes are stored in separate stores, with keys containing the indexed values plus the primary key:

```
Data store (main.users):
  key: encoded(42)  → value: {id:42, email:"alice@example.com", name:"Alice"}

Index store (main.users_idx_email):
  key: encoded("alice@example.com") + encoded(42)  → value: (empty)
```

**Benefits of separate index stores:**
- No prefix needed in index keys (store name already identifies the index)
- Simpler iteration (no filtering required)
- Each index can be managed independently
- Clean separation for index-specific operations

Index maintenance occurs during `update()`:
- INSERT: Add index entries for new row in each index store
- DELETE: Remove index entries for old row from each index store
- UPDATE: Remove old entries, add new entries

The module's `getBestAccessPlan()` considers available indexes when evaluating filter constraints.

## Query Planning

The module implements `getBestAccessPlan()` to communicate capabilities:

| Access Pattern | Cost Model | Provides Ordering |
|----------------|------------|-------------------|
| PK equality | O(1) | Yes (single row) |
| PK range | O(k) where k = matched rows | Yes (BINARY only) |
| Secondary index eq | O(1) + PK lookup | No |
| Secondary index range | O(k) + PK lookups | No |
| Full scan | O(n) | Yes (PK order, BINARY) |

Non-BINARY collations: The module cannot provide collation-aware ordering. It reports `providesOrdering: undefined` and Quereus handles sorting above the Retrieve boundary.

## Schema Discovery

When connecting to existing storage, the module reads DDL from the catalog store and imports it into the in-memory schema manager. The recommended entry point is `rehydrateCatalog()`, which handles loading, importing, and error tolerance in a single call.

### rehydrateCatalog

```typescript
const result = await storeModule.rehydrateCatalog(db);
// result.tables:  string[]           — imported table names
// result.indexes: string[]           — imported index names
// result.errors:  RehydrationError[] — collected failures
```

Each DDL entry is imported individually. A corrupt or unparseable entry is logged and skipped so that other tables still load. Call after `db.registerModule()` (and `db.setDefaultVtabName()` if DDL may lack a USING clause).

Internally, `rehydrateCatalog()` delegates to `loadAllDDL()` (scan the catalog store) and `schemaManager.importCatalog()` (parse + connect). `loadAllDDL()` remains available as a lower-level escape hatch.

### Discovery Flow

1. Module opens storage at configured path/database
2. `rehydrateCatalog(db)` scans catalog store (keys are `{schema}.{table}`, values are DDL)
3. Each entry is imported via `schemaManager.importCatalog([ddl])`
4. Parse failures are collected in `result.errors`; remaining tables load normally
5. Tables become queryable

## Transaction Support

The store module integrates with Quereus's transaction coordinator to provide multi-table atomic transactions.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Quereus Database                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          Transaction Coordinator                     │    │
│  │  - Calls begin/commit/rollback on all connections   │    │
│  │  - Runs global assertions before commit             │    │
│  └─────────────────────────────────────────────────────┘    │
│           │              │              │                    │
│           ▼              ▼              ▼                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ Connection  │ │ Connection  │ │ Connection  │            │
│  │  (users)    │ │  (orders)   │ │  (items)    │            │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘            │
└─────────┼───────────────┼───────────────┼────────────────────┘
          │               │               │
          ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│               LevelDBModule TransactionCoordinator           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Shared WriteBatch                       │    │
│  │  - Collects writes from all tables                  │    │
│  │  - Single atomic write on commit                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│                    ┌─────────────┐                          │
│                    │  LevelDB    │                          │
│                    │  (classic)  │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Connection Registration**: When a table is first accessed, a `LevelDBConnection` is created and registered with the Database
2. **Transaction Begin**: Quereus calls `begin()` on all registered connections; the coordinator starts buffering writes
3. **Mutations**: All `update()` operations queue changes to the shared `WriteBatch` instead of writing directly
4. **Transaction Commit**: Quereus calls `commit()` on connections; the coordinator writes the batch atomically
5. **Transaction Rollback**: The coordinator discards the pending batch; no changes are persisted

### Multi-Table Atomicity

Since all tables in a LevelDB module share the same underlying database (tables are distinguished by key prefixes), a single `WriteBatch` can atomically commit changes across all tables:

```typescript
BEGIN TRANSACTION;
INSERT INTO users VALUES (1, 'Alice');
INSERT INTO orders VALUES (100, 1, 50.00);
INSERT INTO items VALUES (1000, 100, 'Widget');
COMMIT;  -- All three inserts succeed or fail together
```

### Savepoint Support

Savepoints create nested snapshots within a transaction:

```sql
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SAVEPOINT sp1;
INSERT INTO users VALUES (2, 'Bob');
ROLLBACK TO sp1;  -- Discards Bob, keeps Alice
COMMIT;           -- Only Alice is persisted
```

The coordinator maintains a stack of pending operations, rolling back to the appropriate snapshot on `ROLLBACK TO`.

### LevelDB Backend
- All tables share one `ClassicLevel` instance
- `WriteBatch` provides atomic multi-key writes
- Savepoints tracked via operation snapshots

### IndexedDB Backend

**Current architecture**: Each table gets its own IndexedDB **database** by default (e.g., `quereus_main_users`, `quereus_main_orders`). Each database contains a single object store for key-value storage.

- Tables can share a database via `database='shared_name'` option
- Native IDB transaction provides atomicity within a single database
- `transaction.abort()` for rollback

### IndexedDB Architecture Gap

**Current limitation**: The default separate-database-per-table architecture prevents cross-table atomicity:

| Scenario | Atomicity |
|----------|-----------|
| Multiple tables in SAME IDB database | ✅ Native IDB transaction |
| Multiple tables in DIFFERENT IDB databases | ❌ Sequential commits |
| Data tables + sync metadata (different DBs) | ❌ Sequential commits |

**Note on storage quotas**: Browser storage quotas are per-origin, not per-database. Having separate databases does **not** increase available storage—all databases under the same origin share the same quota (~60% of disk on Chrome, ~50% on Firefox, ~1GB on Safari).

**Preferred direction**: Consolidate to a **single IndexedDB database** with multiple object stores (one per table):

| Single Database | Multiple Databases (current) |
|-----------------|------------------------------|
| ✅ Native cross-table transactions | ❌ No cross-DB transactions |
| ✅ Atomicity for sync operations | ❌ Sequential commits |
| ✅ Same storage quota | ✅ Same storage quota |
| ✅ No WAL needed | ⚠️ Would need WAL for atomicity |
| ⚠️ Slightly more complex object store management | ✅ Each table is self-contained |

This matches LevelDB's architecture (single database, key prefixes for tables) and would enable native ACID semantics.

### Isolation Gap

**Additional limitation**: Even with single-database atomicity, the Store module does not provide **isolation** (preventing readers from seeing intermediate states during a transaction).

| Backend | Atomicity | Isolation |
|---------|-----------|-----------|
| LevelDB | ✅ WriteBatch | ❌ Readers see intermediate state |
| IndexedDB (single DB) | ✅ IDB transaction | ❌ Readers see intermediate state |

**Future direction**: Implement isolation using a layered architecture similar to the memory vtab module:

1. **TransactionLayer pattern**: Writers work on an isolated layer that inherits from the committed base
2. **Copy-on-write semantics**: Uncommitted changes are invisible to readers
3. **Atomic visibility**: All changes become visible at once on commit
4. **Rollback**: Discard the transaction layer without affecting readers

This would provide true ACID semantics and enable features like:
- Consistent reads during long-running transactions
- Sync operations that apply atomically across tables
- Snapshot isolation for reporting queries

## Statistics

Row counts are maintained lazily for efficient query planning:

- **Storage**: All table statistics are stored in the unified `__stats__` store, keyed by `{schema}.{table}`
- **Key format**: `{schema}.{table}` as UTF-8 string (e.g., `main.users`)
- **Value format**: JSON `{rowCount: number, updatedAt: timestamp}`
- **Tracking**: Each insert increments count (+1), each delete decrements (-1)
- **Persistence**: After ~100 mutations, stats are flushed to storage in a microtask
- **Flush on close**: Stats are persisted when a table is disconnected
- **No database upgrades**: The `__stats__` store is created at database initialization, so stats persistence never triggers schema upgrades

```typescript
// Access statistics programmatically
const table = module.getTable('main', 'users');
const rowCount = await table.getEstimatedRowCount();
```

The `getBestAccessPlan()` method uses these statistics for cost estimation when choosing between full scans and index lookups.

## Configuration

```sql
-- LevelDB (Node.js)
CREATE TABLE t (...) USING leveldb(path = './data/mydb');

-- IndexedDB (Browser)  
CREATE TABLE t (...) USING indexeddb(database = 'myapp');
```

In practice, applications set the default module:
```typescript
db.setDefaultModule('leveldb', { path: './data' });
// Then users simply: CREATE TABLE t (...)
```

## Schema Migration

Uses lazy migration: rows missing new columns return NULL or the declared default on read. No eager rewriting of existing data.

## Collation Support

The store module uses collation-aware binary encoding to preserve sort order in the underlying key-value store.

### Collation Encoders

Collations can register a `CollationEncoder` that transforms strings before binary encoding:

```typescript
interface CollationEncoder {
  /** Transform string for sort-preserving binary encoding */
  encode(value: string): string;
}
```

### Built-in Collations

| Collation | Encoder | Ordering Support |
|-----------|---------|------------------|
| **NOCASE** | Lowercases before encoding | Full (default) |
| **BINARY** | No transformation | Full |
| **RTRIM** | Trims trailing spaces | Full |
| **Custom** | Falls back to BINARY encoding | Requires Quereus re-sort |

The default collation is **NOCASE**, matching Quereus's case-insensitive comparison semantics.

### Future Work

**TODO**: Add per-column collation specification for primary keys and index columns:

```sql
-- Future syntax (not yet implemented)
CREATE TABLE t (
  name TEXT COLLATE BINARY PRIMARY KEY,
  email TEXT COLLATE NOCASE
) USING leveldb;

CREATE INDEX idx_name ON t(name COLLATE BINARY);
```

## Package Structure

The store system is split across three packages to enable platform-specific packaging:

```
packages/quereus-store/                # Core (platform-agnostic)
  src/
    common/
      encoding.ts       # Key encoding utilities (type-prefixed sort-safe encoding)
      key-builder.ts    # Store naming and key construction utilities
      serialization.ts  # Extended JSON row serialization
      kv-store.ts       # KVStore and KVStoreProvider interfaces
      events.ts         # Schema and data change event emitter
      ddl-generator.ts  # Generate CREATE TABLE/INDEX DDL from schemas
      store-table.ts    # Generic StoreTable (uses KVStore abstraction)
      store-connection.ts  # Generic transaction connection
      store-module.ts   # Generic StoreModule
      transaction.ts    # Transaction coordinator
      index.ts          # Common module exports

packages/quereus-plugin-leveldb/       # Node.js LevelDB plugin
  src/
    store.ts            # LevelDBStore (classic-level wrapper)
    provider.ts         # LevelDBProvider (KVStoreProvider implementation)
    plugin.ts           # Plugin entry point for registerPlugin()
    index.ts            # Package exports

packages/quereus-plugin-indexeddb/     # Browser IndexedDB plugin
  src/
    store.ts            # IndexedDBStore (native IndexedDB wrapper)
    manager.ts          # IndexedDBManager (unified database management)
    provider.ts         # IndexedDBProvider (KVStoreProvider implementation)
    broadcast.ts        # CrossTabSync for BroadcastChannel notifications
    plugin.ts           # Plugin entry point for registerPlugin()
    index.ts            # Package exports
```

## Implementation Status

### Phase 1: Core Infrastructure ✓
- [x] Define `KVStore` interface with get/put/delete/iterate/batch/approximateCount
- [x] Implement key encoding with sort-order preservation (type-prefixed)
- [x] Implement row serialization using extended JSON
- [x] Implement key builder for data rows and secondary indexes
- [x] Implement schema/data change event emitter

### Phase 2: LevelDB Backend ✓
- [x] Implement `LevelDBStore` using `classic-level`
- [x] Implement `LevelDBModule` with create/connect/destroy
- [x] Implement `LevelDBTable` (query with PK point/range/scan, update with insert/update/delete)
- [x] Implement `getBestAccessPlan()` with cost estimation
- [x] Add single-table batch transactions via `WriteBatch`

### Phase 3: Secondary Indexes ✓
- [x] Index storage layout (i:schema.table.index:cols:pk)
- [x] Index maintenance during insert/update/delete
- [x] Index-aware `getBestAccessPlan()` cost estimation
- [x] CREATE INDEX DDL integration (createIndex on modules)

### Phase 4: IndexedDB Backend ✓
- [x] Implement `IndexedDBStore` with full KVStore interface
- [x] Implement `IndexedDBModule` and `IndexedDBTable`
- [x] Cross-tab change notifications via BroadcastChannel

### Phase 5: Schema Persistence ✓
- [x] Metadata storage (DDL strings in m:ddl:* keys)
- [x] Schema discovery via `rehydrateCatalog()` (wraps `loadAllDDL()` + `importCatalog()` with error tolerance)
- [x] DDL generation from TableSchema/IndexSchema
- [x] Reactive hooks for schema changes (StoreEventEmitter)
- [x] Lazy statistics refresh and persistence (~100 mutation batching)
- [x] Comprehensive test suite

### Phase 6: Additional Features ✓
- [x] Multi-table transactions via TransactionCoordinator
- [x] Collation-aware binary encoding infrastructure
- [ ] Per-column collation specification for keys/indexes (TODO)

### Phase 7: IndexedDB Single-Database Architecture ✓
- [x] Migrate from separate IDB databases to single database with multiple object stores
- [x] One object store per table (named by schema.table)
- [x] Sync metadata object store in same database (`__catalog__`)
- [x] Native cross-table IDB transactions for atomicity (`MultiStoreWriteBatch`)
- [x] No WAL needed for crash recovery

**Implementation**: `UnifiedIndexedDBModule` and `UnifiedIndexedDBStore` provide the new architecture.
Use `UnifiedIndexedDBModule` instead of `IndexedDBModule` to opt-in to the unified database.

### Phase 8: Platform Abstraction Layer ✓
- [x] Define `KVStoreProvider` interface for dependency injection
- [x] Create generic `StoreTable` that works with any `KVStore`
- [x] Create generic `StoreConnection` for transaction management
- [x] Core module in `@quereus/store` package
- [x] LevelDB plugin in `@quereus/plugin-leveldb` package
- [x] IndexedDB plugin in `@quereus/plugin-indexeddb` package
- [x] Create `LevelDBProvider` and `IndexedDBProvider` implementations
- [x] Factory functions: `createLevelDBProvider()` and `createIndexedDBProvider()`

This enables custom storage backends by implementing `KVStore` and `KVStoreProvider`.

### Phase 9: Transaction Isolation (Longer-term)
- [ ] Implement TransactionLayer pattern (similar to memory vtab) for read isolation
- [ ] Copy-on-write layer that inherits from committed base
- [ ] Readers see committed snapshot; writers work on isolated layer
- [ ] Atomic visibility on commit
- [ ] Enable sync plugin to leverage Store isolation for ACID sync operations
