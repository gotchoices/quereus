# Isolation Layer Design

## Overview

This document describes a **generic transaction isolation layer** that can wrap any `VirtualTableModule` to provide ACID transaction semantics with read-your-own-writes, snapshot isolation, and savepoint support.

The goal is to decouple **storage** concerns from **isolation** concerns:

- **Storage modules** (memory, LevelDB, IndexedDB, custom) focus on persistence and indexing
- **Isolation layer** provides consistent transaction semantics across all modules

This enables module authors to implement simple read/write logic while getting full transaction support "for free."

---

## Motivation

### Current State

The memory virtual table module (`@quereus/quereus`) implements its own transaction isolation using `inheritree` B+Trees with copy-on-write inheritance. This works well but:

1. The isolation logic is tightly coupled to the storage implementation
2. Other modules (store, sync, custom) must re-implement isolation from scratch
3. Each implementation has different semantics and edge cases

The store modules (`quereus-store`) currently have no read isolation—queries see committed data only, not pending writes from the current transaction.

### Desired State

A composable isolation layer that:

- Wraps any underlying module transparently
- Provides consistent MVCC-style isolation semantics
- Handles savepoints via nested layers
- Is well-tested in one place rather than per-module

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │                                                     │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Supports range scans, index lookups, etc.       │ │
│  │  - Savepoints via module's own transaction support │ │
│  │  - Any module that supports isolation can serve    │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │                                                     │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  │  - Any VirtualTableModule supporting query/update  │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Principle: Row-Level Composition

The isolation layer operates purely at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

Both modules are accessed through the standard `VirtualTable` and `VirtualTableConnection` interfaces. The isolation layer has no knowledge of BTrees, blocks, LevelDB, or any implementation details.

### Why Use a Module as Overlay Storage?

Using an existing module for overlay storage provides:

- **Range scan support** — The overlay module already implements efficient range iteration
- **Secondary index support** — The overlay module maintains its own indexes
- **Savepoint support** — The overlay module's transaction semantics handle savepoints
- **Consistency** — Same query semantics for overlay and underlying data

The isolation layer's only job is merging two row streams.

### Overlay Module Selection

The overlay module is configurable and can be any module that supports isolation:

| Overlay Module | Use Case |
|----------------|----------|
| Memory vtab | Default; fast, ephemeral, suitable for most transactions |
| LevelDB/IndexedDB | Large transactions, crash recovery of uncommitted work |
| Same as underlying | Uniform storage, useful for testing |

The key requirement is that the overlay module must support the capabilities needed for isolation (particularly savepoints if the isolation layer exposes savepoint support).

### Per-Connection Overlay Architecture

The isolation layer uses a **per-connection overlay** architecture:

```
IsolationModule
├── underlyingTables: Map<"schema.table", UnderlyingTableState>
│   └── underlyingTable (shared across all connections)
│
└── connectionOverlays: Map<"dbId:schema.table", ConnectionOverlayState>
    ├── Connection 1: overlayTable, hasChanges
    ├── Connection 2: overlayTable, hasChanges
    └── ...
```

**Key properties:**

1. **Underlying tables are shared** — All connections read from the same committed data
2. **Overlays are per-connection** — Each database instance gets its own overlay per table
3. **Overlays are created lazily** — No memory overhead until first write in a transaction
4. **Schema is discovered lazily** — Supports modules that load schema from persistent storage

This architecture ensures:
- Read-your-own-writes: A connection sees its own uncommitted changes
- Isolation: Other connections don't see uncommitted changes
- Efficiency: No overlay created for read-only transactions

---

## Core Concepts

### Overlay Storage

The overlay is a virtual table instance (typically from the memory vtab module) that stores uncommitted changes for a connection. It mirrors the schema of the underlying table, including:

- Primary key columns
- All data columns
- Secondary indexes

The overlay table has an additional hidden column or marker to distinguish tombstones (deleted rows) from regular rows.

### Change Types

The overlay stores three types of changes as rows:

1. **Insert** — New row not present in underlying module (stored as regular row)
2. **Update** — Modified row replacing one in underlying module (stored as regular row)
3. **Delete** — Tombstone marking a row as removed (stored with tombstone marker)

The isolation layer doesn't distinguish inserts from updates—both are simply "this PK should return this row." The distinction only matters at commit time when applying to the underlying module.

### Merge Semantics

When reading, the isolation layer merges overlay changes with underlying data:

```
For each row from underlying module:
  - If overlay has tombstone for this PK → skip row
  - If overlay has update for this PK → emit overlay row instead
  - Otherwise → emit underlying row

For each insert in overlay not yet emitted:
  - Emit at correct sort position
```

This is analogous to LSM-tree merge or 3-way merge in version control.

---

## Transaction Lifecycle

### Begin Transaction

1. Create new `OverlayState` for this connection (or inherit from existing if nested)
2. Call `underlyingConnection.begin()` to start underlying transaction

### Read Operations

1. Execute query against overlay first
2. Execute same query against underlying module
3. Merge results using primary key ordering
4. For index scans: consult overlay's secondary index to find additional/removed keys

### Write Operations

1. Apply change to overlay only (insert/update/delete)
2. Update overlay's primary index
3. Update overlay's secondary indexes
4. Do NOT write to underlying module yet

### Savepoint

1. Call `overlayConnection.savepoint(n)` to create savepoint in overlay module
2. The overlay module handles the savepoint semantics internally

### Rollback to Savepoint

1. Call `overlayConnection.rollbackToSavepoint(n)` to revert overlay changes
2. The overlay module discards changes made after the savepoint

### Commit

1. Collect all changes from overlay
2. Apply to underlying module via `update()` calls
3. Call `underlyingConnection.commit()`
4. Clear overlay state

### Rollback

1. Discard overlay state entirely
2. Call `underlyingConnection.rollback()`

---

## Capability Discovery

Modules should advertise their isolation support so consumers can make informed decisions.

### Capability Interface

```typescript
interface ModuleCapabilities {
  /** Module provides transaction isolation (read-your-own-writes, snapshot reads) */
  isolation?: boolean;

  /** Module supports savepoints within transactions */
  savepoints?: boolean;

  /** Module persists data across restarts */
  persistent?: boolean;

  /** Module supports secondary indexes */
  secondaryIndexes?: boolean;
}

interface VirtualTableModule {
  // ... existing methods

  /** Returns capability flags for this module */
  getCapabilities?(): ModuleCapabilities;
}
```

### Usage

```typescript
const module = db.getModule('store');
const caps = module.getCapabilities?.() ?? {};

if (!caps.isolation) {
  // Wrap with isolation layer, or warn user
  console.warn('Module does not provide isolation; queries may see partial writes');
}
```

### Wrapped Module Capabilities

When the isolation layer wraps a module, it augments the capabilities:

| Capability | Underlying | Wrapped Result |
|------------|------------|----------------|
| `isolation` | `false` | `true` |
| `savepoints` | `false` | `true` |
| `persistent` | (passthrough) | (passthrough) |
| `secondaryIndexes` | (passthrough) | (passthrough) |

---

## Secondary Index Handling

### Why the Overlay Must Have Matching Indexes

Consider a table with a secondary index on `email`:

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
CREATE INDEX idx_email ON users(email);
```

A query like:

```sql
SELECT * FROM users WHERE email = 'alice@example.com';
```

Uses the secondary index. If the overlay only tracks by primary key:

1. Query asks underlying module's index for `email = 'alice@example.com'`
2. Underlying returns row with `id = 5`
3. But overlay might have deleted id=5, or updated its email to something else!

The overlay table must have the same indexes as the underlying table so that:
- Index scans on overlay find pending inserts/updates by index key
- Merge can correctly combine overlay and underlying index scan results

### Overlay Table Schema

The isolation layer creates an overlay table with:
- Same columns as underlying table
- Same primary key
- Same secondary indexes
- Additional tombstone marker column

This is handled automatically when the isolation layer creates the overlay table instance.

### Index Scan Merge

When scanning via secondary index:

1. Execute index scan on overlay table → returns overlay rows matching index predicate
2. Execute index scan on underlying table → returns committed rows matching predicate
3. Merge by primary key:
   - Overlay tombstone for PK → skip underlying row
   - Overlay row for PK → emit overlay row, skip underlying
   - No overlay entry → emit underlying row

---

## Key Ordering

### The Problem

For merge iteration to work correctly, the overlay must iterate in the **same order** as the underlying module. Different modules may use different orderings:

| Module | Ordering |
|--------|----------|
| Memory vtab | `compareSqlValues()` with collation support |
| Store module | Binary-encoded keys (lexicographic byte order) |

If these differ, merge produces incorrect results.

### Solution: Module-Provided Comparator

The underlying module must provide its key comparison function:

```typescript
interface IsolationCapableTable extends VirtualTable {
  /** Compare two rows by primary key, using module's native ordering */
  comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

  /** Extract primary key values from a row */
  extractPrimaryKey(row: Row): SqlValue[];

  /** Compare index keys for a given index */
  compareIndexKey(indexName: string, a: SqlValue[], b: SqlValue[]): number;
}
```

The isolation layer passes these comparators to the overlay module (if configurable) or validates that the overlay and underlying modules use compatible orderings.

### Collation Considerations

For text columns with non-binary collation (NOCASE, etc.):

- The underlying module's comparator must respect the collation
- The overlay uses the same comparator
- Both iterate in the same order

---

## Cross-Layer Constraint Detection

### Why Resolve at Write Time

UNIQUE and PRIMARY KEY constraints span the merged view: a write that does not
collide within the overlay may still collide with an un-tombstoned row in the
underlying table. Deferring detection to flush time would make overwrites silent
and lose the chance to honour `ON CONFLICT IGNORE`/`REPLACE` semantics. Detection
therefore happens in `IsolatedTable.update()` before the overlay write proceeds.

### PK Conflict (`checkMergedPKConflict`)

Called when an INSERT or PK-changing UPDATE produces a new PK with no overlay
entry at that key:

- Underlying has no row at the PK → no conflict.
- Underlying has a row → ABORT returns a constraint result (with `existingRow`
  populated), IGNORE silently no-ops, REPLACE returns null and lets the insert
  proceed (the overlay row will become an UPDATE at flush).

### Non-PK UNIQUE Conflict (`checkMergedUniqueConstraints`)

For each declared non-PK UNIQUE constraint:

- Skip if the new row is null on any constrained column (SQL NULL semantics).
- Scan the underlying table for a row matching on all constrained columns,
  excluding the writer's own PK(s) and any PK currently tombstoned in the
  overlay.
- ABORT returns the constraint result; IGNORE no-ops; REPLACE writes a
  tombstone for the conflicting underlying PK so the row is evicted at flush,
  then continues.

### Tombstones for Evicted Rows

`insertTombstoneForPK` writes a row with PK columns populated and all other
columns (including the constrained UNIQUE columns) set to NULL, plus the
tombstone marker. The null UNIQUE columns ensure the tombstone itself never
matches a future merged-view UNIQUE check, and the underlying scan skips any
PK that has a tombstone in the overlay.

### Trade-offs

- Non-PK UNIQUE checks currently do an O(n) scan of the underlying for each
  write. The overlay's own UNIQUE constraint enforcement covers overlay-only
  conflicts; the merged-view scan only fills the underlying-only gap. Index-
  based lookup is a future optimisation.
- Same-PK REPLACE returns null instead of carrying the replaced row back to
  the DML executor, so FK CASCADE side-effects do not fire for replacements
  resolved through the isolation layer (tracked separately).

---

## Challenges and Mitigations

### 1. Merge Iteration Complexity

**Challenge:** Merging two ordered streams while handling inserts, updates, and deletes is error-prone.

**Mitigation:**
- Implement as a standalone, well-tested `MergeIterator` utility
- Use property-based testing (fast-check) to verify invariants:
  - Output is correctly ordered
  - All overlay changes appear in output
  - Deleted rows never appear
  - Updates replace originals exactly once
- Keep stateless: input two async iterables, output one

### 2. Cursor Invalidation During Mutation

**Challenge:** If a query is iterating and a write occurs, the cursor may be invalid.

**Mitigation:**
- Writes go to overlay module, which has its own cursor safety semantics
- If overlay module supports snapshot isolation (memory vtab does), iteration is safe
- Document behavior based on overlay module's capabilities

### 3. Commit Failure Recovery

**Challenge:** If the underlying module fails mid-commit, the overlay has partially flushed.

**Mitigation:**
- Collect all changes before any writes
- Write all changes, then commit underlying transaction
- If writes fail, underlying transaction rolls back (atomic)
- Overlay remains intact; user can retry or rollback

### 4. Performance Overhead

**Challenge:** Every read now goes through overlay check + merge.

**Mitigation:**
- Fast path: if overlay is empty, delegate directly to underlying
- Track "has changes" flag to skip merge when unnecessary
- For point lookups: check overlay first (O(log n)), only hit underlying if not found
- Accept some overhead in exchange for correctness and simplicity

### 5. Large Transaction Storage

**Challenge:** Large transactions may accumulate many uncommitted changes in the overlay.

**Mitigation:**
- The overlay module is configurable—use memory vtab for small/fast transactions
- For large transactions, use a persistent overlay module (e.g., temp LevelDB instance)
- This is a deployment/configuration choice, not a limitation of the architecture

### 6. Schema Operations (DDL)

**Challenge:** CREATE INDEX, ALTER TABLE, DROP TABLE don't fit the row-based overlay model.

**Mitigation:**
- DDL operations bypass the overlay and go directly to underlying module
- Schema changes may have their own transactional semantics
- Document that DDL is not isolated in the same way as DML

---

## Relationship to Memory VTab

### Current Memory VTab Architecture

The memory vtab uses `inheritree` BTrees for both storage and isolation in a tightly integrated design:

- Base data stored in BTrees
- Transaction layers created via BTree copy-on-write inheritance
- Efficient single-layer design, but couples storage and isolation

### Future Options

**Option A: Keep Memory VTab Special**

Memory vtab continues using integrated approach for performance. Isolation layer used only for store and custom modules.

- Pros: No performance regression for memory vtab
- Cons: Two isolation implementations to maintain

**Option B: Unify Under Isolation Layer**

Create a "raw memory module" (BTrees, no isolation) and wrap with isolation layer.

- Pros: Single isolation implementation, simpler memory vtab
- Cons: Some performance overhead, two layers of BTrees

**Recommendation:** Start with Option A. Measure performance of Option B. Migrate if overhead is acceptable.

---

## API Surface

### Wrapping a Module

```typescript
import { IsolationModule } from '@quereus/isolation';
import { StoreModule } from '@quereus/store';
import { MemoryModule } from '@quereus/quereus';

// Create underlying module (the persistent storage)
const storeModule = new StoreModule(leveldb);

// Create overlay module (for uncommitted changes)
const overlayModule = new MemoryModule();  // Or another StoreModule, etc.

// Wrap with isolation
const isolatedModule = new IsolationModule({
  underlying: storeModule,
  overlay: overlayModule,
});

// Register with database
db.registerModule('store', isolatedModule);
```

### Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
// { isolation: true, savepoints: true, persistent: true, ... }
```

### Transparent Usage

Once wrapped, usage is identical to any other module:

```sql
CREATE VIRTUAL TABLE users USING store (...);
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SELECT * FROM users WHERE id = 1;  -- Returns Alice (read-your-own-write)
ROLLBACK;
SELECT * FROM users WHERE id = 1;  -- Returns nothing
```

---

## Testing Strategy

### Unit Tests

- `OverlayState`: insert, update, delete, iteration, savepoints
- `MergeIterator`: all combinations of overlay/underlying states
- Secondary index tracking: insert, update, delete propagation

### Property-Based Tests

Using fast-check or similar:

- Generate random sequences of operations
- Apply to isolated module and a reference implementation
- Verify results match

### Integration Tests

- Wrap memory vtab with isolation layer, run existing memory vtab tests
- Wrap store module with isolation layer, verify read-your-own-writes
- Multi-table transactions with mixed modules

---

## TODO

### Phase 1: Core Infrastructure ✅

- [x] Define `ModuleCapabilities` interface in `@quereus/quereus`
- [x] Add `getCapabilities()` to `VirtualTableModule` interface
- [x] Implement capabilities for memory module
- [x] Define `IsolationCapableTable` interface with key extraction and comparison

### Phase 2: Merge Iterator ✅

- [x] Implement `mergeStreams()` for combining two row streams by primary key
- [x] Handle all cases: overlay insert, overlay update, overlay tombstone, passthrough
- [x] Comprehensive unit tests for ordering and completeness invariants
- [x] Test with various key types and orderings (integer, composite, text)

### Phase 3: Isolation Layer Core ✅

- [x] Implement `IsolationModule` wrapping `VirtualTableModule`
- [x] Implement `IsolatedTable` wrapping `VirtualTable`
- [x] Implement `IsolatedConnection` wrapping `VirtualTableConnection`
- [x] Create overlay table with matching schema + tombstone column
- [x] Wire up transaction lifecycle (begin, commit, rollback, savepoints)

### Phase 4: Query Routing ✅

- [x] Route writes to overlay table with tombstone support
- [x] Route reads through merge iterator (overlay + underlying)
- [x] Implement commit flush (apply overlay to underlying with independent transaction)
- [x] Implement `clearOverlay()` for overlay reset after commit/rollback
- [x] Per-connection overlay storage (each DB instance gets its own overlay per table)
- [x] Lazy overlay creation (overlay created on first write, using schema from underlying)
- [x] Proper transaction isolation (rollback doesn't affect committed data)
- [x] Handle index scans via overlay indexes (streaming merge with sort key comparators)

### Phase 5: Integration

- [x] Add isolation layer to store module (opt-in via `createIsolatedStoreModule()`)
- [x] Implement capabilities for store module (`getCapabilities()` reports `isolation: false`)
- [x] Update store module documentation (show example of using memory table backed isolation layer)
- [x] Run store module tests with isolation enabled (basic read-your-own-writes tests pass)
- [ ] Full integration testing (autocommit mode, savepoint coordination with underlying store)

### Phase 6: Optimization

- [ ] Switch Quoomb Web's Store and Sync modes to use isolated.
- [x] O(log n) PK point lookups via `buildPKPointLookupFilter()` (overlay reads and underlying existence checks)
- [x] O(1) `clearOverlay()` via reference discard instead of row-by-row deletion
- [ ] Performance benchmarking vs. non-isolated access

---

## Optimization Strategies

### Current Overhead Analysis

For a single-statement autocommit write (the most common case), the current flow is:

```
Statement.run()
  → _beginImplicitTransaction()
  → IsolatedTable.update()
      → ensureConnection()
      → ensureOverlay()           ← Creates overlay table + indexes
      → write to overlay          ← Memory allocation, BTree insert
  → _commitImplicitTransaction()
      → flushOverlayToUnderlying()
          → full scan overlay     ← Iterate all overlay entries
          → for each entry:
              → rowExistsInUnderlying()  ← Full scan to check existence!
              → underlying.update()
          → underlying.commit()
      → clearOverlay()
```

**Key inefficiencies:**

1. **Overlay creation overhead** — Schema cloning, index creation, even for a single row
2. **Double write** — Row written to overlay, then copied to underlying
3. **Full scan for existence check** — `rowExistsInUnderlying()` does a full table scan per row
4. **Overlay scan at commit** — Even for one row, we iterate the overlay

### Optimization 1: Direct Passthrough for Write-Only Autocommit

**Scenario:** Single DML statement in autocommit mode with no subsequent reads.

**Insight:** If we're just doing `INSERT INTO t VALUES (...)` with no reads, we don't need the overlay at all. The write can go directly to the underlying module.

**Detection:**
- Autocommit mode (no explicit `BEGIN`)
- Statement is pure DML (INSERT/UPDATE/DELETE) without RETURNING
- No reads from the same table within the statement

**Implementation:**

```typescript
interface IsolationModuleConfig {
  // ... existing
  
  /** Enable direct passthrough for write-only autocommit statements */
  enableDirectPassthrough?: boolean;  // default: true
}

class IsolatedTable {
  private directPassthroughMode = false;
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Check if we can use direct passthrough
    if (this.canUseDirectPassthrough()) {
      this.directPassthroughMode = true;
      return this.underlyingTable.update(args);
    }
    
    // ... existing overlay logic
  }
  
  private canUseDirectPassthrough(): boolean {
    return (
      this.db.getAutocommit() &&           // Autocommit mode
      !this.hasChanges &&                   // No prior writes in this "transaction"
      !this.overlayTable &&                 // Overlay not yet created
      !this.pendingReads                    // No reads pending (would need overlay)
    );
  }
  
  async commit(): Promise<void> {
    if (this.directPassthroughMode) {
      // Already written to underlying, just commit
      await this.underlyingTable.commit?.();
      this.directPassthroughMode = false;
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Eliminates all overlay overhead for simple writes.

**Risk:** Must ensure no reads occur after the write within the same implicit transaction. The planner/executor could hint this.

### Optimization 2: Lazy Overlay with Deferred Creation

**Current:** Overlay created on first write.

**Improvement:** Defer overlay creation until a read-after-write occurs.

```typescript
class IsolatedTable {
  /** Pending writes before overlay is created */
  private pendingWrites: UpdateArgs[] = [];
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    if (!this.overlayTable && this.db.getAutocommit()) {
      // Buffer the write, don't create overlay yet
      this.pendingWrites.push(args);
      this.hasChanges = true;
      // Return optimistic result
      return args.values;
    }
    
    // ... existing logic if overlay exists or explicit transaction
  }
  
  query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (this.pendingWrites.length > 0) {
      // Read-after-write detected, materialize overlay now
      await this.materializePendingWrites();
    }
    // ... existing merge logic
  }
  
  async commit(): Promise<void> {
    if (this.pendingWrites.length > 0 && !this.overlayTable) {
      // No reads occurred, apply directly to underlying
      for (const write of this.pendingWrites) {
        await this.underlyingTable.update(write);
      }
      await this.underlyingTable.commit?.();
      this.pendingWrites = [];
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Avoids overlay creation for write-only transactions.

### Optimization 3: Existence Check via Point Lookup

**Current:** `rowExistsInUnderlying()` does a full table scan.

**Fix:** Use primary key lookup instead.

```typescript
private async rowExistsInUnderlying(pk: SqlValue[]): Promise<boolean> {
  if (!this.underlyingTable.query) return false;
  
  // Build point lookup filter using PK constraints
  const pkFilter = this.buildPKPointLookupFilter(pk);
  
  for await (const _row of this.underlyingTable.query(pkFilter)) {
    return true;  // Found it
  }
  return false;
}

private buildPKPointLookupFilter(pk: SqlValue[]): FilterInfo {
  const pkIndices = this.getPrimaryKeyIndices();
  const constraints = pkIndices.map((colIdx, i) => ({
    column: colIdx,
    op: IndexConstraintOp.EQ,
    value: pk[i],
  }));
  
  return {
    idxNum: 0,
    idxStr: '_pk_point_lookup',
    constraints,
    args: pk,
    // ... rest of FilterInfo
  };
}
```

**Benefit:** O(log n) instead of O(n) for existence checks.

### Optimization 4: Batch Commit

**Current:** Each overlay entry applied individually to underlying.

**Improvement:** Collect all changes and apply via batch API if available.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  // ... collect overlay entries ...
  
  // Check if underlying supports batch writes
  if (this.underlyingTable.batchUpdate) {
    await this.underlyingTable.batchUpdate(overlayEntries.map(e => ({
      operation: e.isTombstone ? 'delete' : 'upsert',
      values: e.dataRow,
      key: e.pk,
    })));
  } else {
    // Fallback to individual updates
    for (const entry of overlayEntries) {
      // ... existing logic
    }
  }
}
```

**Benefit:** Reduces round-trips for underlying modules that support batching (LevelDB, IndexedDB).

### Optimization 5: Read-Only Transaction Fast Path

**Scenario:** Transaction with only reads (SELECT).

**Current:** Overlay is never created (good), but merge logic still checks `hasChanges`.

**Already Implemented:** The `query()` method has this fast path:

```typescript
// Fast path: no overlay or no changes, skip merge overhead
if (!this.overlayTable || !this.hasChanges) {
  return this.underlyingTable.query(filterInfo);
}
```

**Enhancement:** Could also skip connection registration for read-only access.

### Optimization 6: Upsert Semantics

**Current:** At commit, we check `rowExistsInUnderlying()` to decide insert vs update.

**Improvement:** If underlying module supports UPSERT (INSERT OR REPLACE), use it.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  const supportsUpsert = this.underlyingTable.capabilities?.upsert;
  
  for (const entry of overlayEntries) {
    if (entry.isTombstone) {
      await this.underlyingTable.update({ operation: 'delete', ... });
    } else if (supportsUpsert) {
      // Skip existence check, let underlying handle it
      await this.underlyingTable.update({
        operation: 'insert',
        onConflict: ConflictResolution.REPLACE,
        values: entry.dataRow,
      });
    } else {
      // ... existing check-then-insert/update logic
    }
  }
}
```

**Benefit:** Eliminates existence check overhead for modules supporting upsert.

### Optimization 7: Planner Hints

The query planner knows the statement structure. It could provide hints to the isolation layer:

```typescript
interface IsolationHints {
  /** Statement is write-only (no reads from written tables) */
  writeOnly?: boolean;
  
  /** Statement is read-only */
  readOnly?: boolean;
  
  /** Tables that will be read after write */
  readAfterWriteTables?: string[];
  
  /** Single-row operation (point insert/update/delete) */
  singleRow?: boolean;
}
```

The executor could pass these hints, allowing the isolation layer to choose optimal strategies.

### Optimization Summary

| Optimization | Benefit | Complexity | Priority |
|-------------|---------|------------|----------|
| Direct passthrough | Eliminates overlay for write-only | Medium | High |
| PK point lookup | O(log n) existence check | Low | High |
| Upsert semantics | Skip existence check | Low | High |
| Deferred overlay | Avoid overlay for write-only | Medium | Medium |
| Batch commit | Fewer round-trips | Medium | Medium |
| Planner hints | Informed optimization | High | Low |

### Recommended Implementation Order

1. **PK point lookup** — Simple fix with immediate benefit
2. **Upsert semantics** — Leverage existing module capabilities  
3. **Direct passthrough** — Major win for common case
4. **Batch commit** — Depends on underlying module support
5. **Planner hints** — Requires cross-layer coordination

---

## References

- [SQLite Virtual Table docs](https://sqlite.org/vtab.html) — Transaction semantics
- [LSM-Tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree) — Similar merge concepts
- Memory VTab source — Reference implementation for overlay module with isolation support

