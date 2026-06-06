# @quereus/isolation

Generic transaction isolation layer for Quereus virtual table modules.

## Overview

The `@quereus/isolation` package provides MVCC-style transaction isolation semantics for any Quereus virtual table module. It wraps existing modules to add:

- **Read-your-own-writes** — See uncommitted changes within your transaction
- **Snapshot isolation** — Consistent reads throughout the transaction
- **Savepoint support** — Nested transaction control
- **ACID semantics** — Full transaction guarantees

This allows module authors to focus on storage concerns while getting isolation "for free."

## Installation

```bash
yarn add @quereus/isolation @quereus/quereus
```

## Quick Start

```typescript
import { Database, MemoryTableModule } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';

const db = new Database();

// Create any underlying module (memory, store, custom, etc.)
const memoryModule = new MemoryTableModule();

// Wrap it with the isolation layer
const isolatedModule = new IsolationModule({
	underlying: memoryModule,
});

db.registerModule('isolated', isolatedModule);

// Use it like any other module, but with full isolation
await db.exec(`CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	name TEXT
) USING isolated`);

await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

// Reads see uncommitted changes
const user = await db.get('SELECT * FROM users WHERE id = 1');
console.log(user.name); // 'Alice'

await db.exec('COMMIT'); // Or ROLLBACK
```

## Architecture

The isolation layer operates at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Per-connection isolation                        │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Features

**Per-connection overlay** — Each database instance gets its own overlay storage, ensuring proper isolation between connections.

**Lazy overlay creation** — No memory overhead until the first write in a transaction.

**Transparent hook forwarding** — `IsolationModule` is a wrapper, so the engine/planner/lens machinery reaches *it* (the registered module) rather than the underlying. Optional `VirtualTableModule` hooks whose behavior is isolation-transparent are forwarded straight through to the underlying: `getMappingAdvertisements` (decomposition shape), `getBestAccessPlan` (index awareness), and the `beginSchemaBatch` / `endSchemaBatch` APPLY SCHEMA batch hooks (single-substrate-commit batching of migration DDL). Hooks whose underlying value would *misdescribe* the wrapped behavior are intentionally **not** forwarded: `getCapabilities` is augmented with `isolation`/`savepoints` rather than passed through verbatim; `supports` (full-query push-down) is suppressed so the overlay always sees every row to merge; and `concurrencyMode` / `expectedLatencyMs` are left at their conservative defaults (`serial` / `0`) so the parallel runtime never issues concurrent calls that would corrupt overlay-merge state.

**Atomic ALTER (issuer-faithful) + cross-connection poison** — DDL through Quereus is not transaction-scoped and the shared underlying base auto-commits its mutation immediately, so a half-applied ALTER cannot be rolled back. The blast radius is isolation-faithful — an ALTER never depends on another connection's uncommitted data:

- **Issuer's own overlay** — `IsolationModule.alterTable` dry-run **validates the issuing connection's own affected overlay's backfill** (per-row `NOT NULL` checks and the tombstone-present guard) *before* mutating the underlying. A rejection fires while the underlying, the schema catalog, and every overlay are still untouched, so for the issuer an ADD COLUMN either fails clean or fully applies — base and catalog never diverge. (The issuer staged both the data and the DDL, so rejecting up front is the least-surprising behavior.)
- **Another connection's overlay** — the shared underlying and the catalog change regardless of any *other* connection's uncommitted state. A foreign overlay that *can* migrate is carried forward as usual; one that *cannot* (its staged row can't satisfy the new `NOT NULL` column) is left in place and marked **poisoned**. Its owning connection then raises a `CONSTRAINT` error the next time it reads (merged), writes, or commits that table, and recovers by rolling back (which discards the overlay and its poison). A committed-snapshot (`committed.<table>`) read bypasses the overlay and keeps working. A layer-invariant violation (e.g. a missing tombstone column, `INTERNAL`) still rethrows loud for everyone rather than poisoning.

**Configurable overlay module** — Use memory for fast transactions, or persistent storage for large transactions:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MemoryTableModule } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';

// Fast, ephemeral overlay (default)
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new MemoryTableModule(),
});

// Or use persistent overlay for large transactions
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new StoreModule(tempStoreProvider),
});
```

## API

### `IsolationModule`

```typescript
class IsolationModule implements VirtualTableModule {
	constructor(config: IsolationModuleConfig);
	getCapabilities(): ModuleCapabilities;
}
```

#### Configuration

```typescript
interface IsolationModuleConfig {
	/** Module to wrap with isolation semantics */
	underlying: VirtualTableModule<any, any>;

	/** Optional overlay module (defaults to MemoryTableModule) */
	overlay?: VirtualTableModule<any, any>;

	/** Optional tombstone column name (defaults to '_tombstone') */
	tombstoneColumn?: string;
}
```

### Merge Utilities

The package also exports low-level utilities for merging sorted streams:

```typescript
import { mergeStreams, createMergeEntry, createTombstone } from '@quereus/isolation';

// Merge two sorted streams (overlay and underlying)
const merged = mergeStreams(overlayStream, underlyingStream, {
	comparePK: (a, b) => /* compare primary keys */,
	extractPK: (row) => /* extract PK from row */,
});
```

See the [design document](https://github.com/gotchoices/quereus/blob/main/docs/design-isolation-layer.md) for detailed architecture and implementation notes.

## Use Cases

### Store Module Isolation

The `@quereus/store` package provides a convenience function:

```typescript
import { createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });
const module = createIsolatedStoreModule({ provider });

db.registerModule('store', module);
```

### Custom Module Isolation

Wrap any custom module:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MyCustomModule } from './my-module';

const isolatedModule = new IsolationModule({
	underlying: new MyCustomModule(),
});
```

## Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
console.log(caps.isolation);  // true
console.log(caps.savepoints); // true
console.log(caps.persistent); // (from underlying module)
```

## Performance

The isolation layer adds minimal overhead:

- **Fast path** — No overlay merging if no writes have occurred
- **Point lookups** — O(log n) via PK index seek on the overlay
- **Range scans** — Streaming merge of sorted results
- **Commit flush** — O(log n) per-row existence check against the underlying table

For performance-critical applications, consider:
- Using memory overlay for small transactions
- The memory vtab uses integrated isolation (no separate layer)

## Testing

```bash
yarn test
```

## License

MIT

## Related Packages

- [@quereus/quereus](https://www.npmjs.com/package/@quereus/quereus) — Core SQL engine
- [@quereus/store](https://www.npmjs.com/package/@quereus/store) — Abstract key-value storage
- [@quereus/plugin-leveldb](https://www.npmjs.com/package/@quereus/plugin-leveldb) — LevelDB storage
- [@quereus/plugin-indexeddb](https://www.npmjs.com/package/@quereus/plugin-indexeddb) — IndexedDB storage
