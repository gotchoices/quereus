# Memory Table Module Documentation

The Memory Table Module provides virtual tables backed by memory for the Quereus engine. These tables support standard SQL operations with full ACID transaction support and can be used for high-performance in-memory data storage that requires SQL query capabilities.

## Architecture Overview

The `MemoryTable` implementation (`src/vtab/memory/`) provides a sophisticated, layer-based MVCC (Multi-Version Concurrency Control) system using inherited BTrees with copy-on-write semantics.

### **Core Components:**

*   **`MemoryTableModule`** (`src/vtab/memory/module.ts`): Factory for creating and managing memory table instances
*   **`MemoryTable`** (`src/vtab/memory/table.ts`): Connection-specific table interface that delegates to the manager
*   **`MemoryTableManager`** (`src/vtab/memory/layer/manager.ts`): Shared state manager handling schema, connections, and layer lifecycle
*   **Layer System**: MVCC implementation with inherited BTrees
    *   **`BaseLayer`** (`src/vtab/memory/layer/base.ts`): Root layer containing the canonical table data
    *   **`TransactionLayer`** (`src/vtab/memory/layer/transaction.ts`): Transaction-specific modifications using inherited BTrees
    *   **`MemoryTableConnection`** (`src/vtab/memory/layer/connection.ts`): Per-connection state with transaction and savepoint support

### **Inherited BTree Backend:**

*   **Backend Library:** Uses the `inheritree` library (fork of `digitree`) for efficient, sorted storage with copy-on-write inheritance
*   **Inheritance Model:** Each `TransactionLayer` creates BTrees that inherit from their parent layer's BTrees, providing automatic data propagation without complex change tracking
*   **Copy-on-Write:** Modifications in child layers only copy pages when necessary, sharing immutable pages with parent layers
*   **Layer Promotion:** The `clearBase()` method allows transaction layers to become independent, supporting efficient layer collapse

## **Key Features:**

### **MVCC Transaction Support:**
*   **Isolation:** Each connection sees a consistent snapshot of data throughout its transaction
*   **Concurrency:** Multiple connections can read/write simultaneously with proper isolation
*   **Savepoints:** Full support for nested savepoints within transactions (`SAVEPOINT`, `ROLLBACK TO`, `RELEASE`)
*   **Layer Collapse:** Automatic promotion and cleanup of committed layers when safe

### **Reactive Event Hooks:**
*   **Data Change Events:** Subscribe to INSERT, UPDATE, DELETE events (fired on commit)
*   **Schema Change Events:** Subscribe to CREATE/ALTER/DROP operations for tables, columns, and indexes
*   **Fine-Grained Tracking:** UPDATE events include `changedColumns` for intelligent cache invalidation
*   **Zero Overhead:** Event tracking only enabled when listeners are registered
*   See [Module Authoring Guide](module-authoring.md#database-level-event-system) for complete documentation

### **Indexing and Query Planning:**
*   **Unified Index Treatment:** Primary and secondary indexes are treated uniformly using inherited BTrees
*   **Flexible Primary Indexing:** Data is organized by user-defined single-column or composite `PRIMARY KEY`
*   **Secondary Index Support:** `CREATE INDEX` and `DROP INDEX` on single or multiple columns, all backed by inherited BTrees
*   **Query Planning:** Implements `xBestIndex` for optimal query execution:
    *   Index selection for equality and range queries
    *   Full table scans (ascending/descending based on primary key)
    *   Fast equality lookups (`WHERE indexed_col = ?`) on single or composite keys
    *   Range scans (`WHERE indexed_col > ?`, etc.) on the first column of chosen index
    *   Prefix-equality + trailing-range scans on composite indexes (`WHERE a = ? AND b > ?` on `idx(a, b)`)
    *   `ORDER BY` satisfaction using index ordering

### **Schema Evolution:**
*   **Dynamic Schema Changes:** `ALTER TABLE` support for adding, dropping, and renaming columns
*   **Primary Key Alteration:** `ALTER TABLE ... ALTER PRIMARY KEY` is supported via an automatic table rebuild. The rebuild creates a new table with the new PK definition, copies all rows, and swaps it in place. If duplicate-key violations occur during the rebuild, the operation fails cleanly without data loss (the original table is unchanged).
*   **Index Management:** Runtime creation and deletion of secondary indexes
*   **Schema Safety:** Operations ensure consistency across all active transactions

### **Performance Optimizations:**
*   **Inherited Data Access:** Automatic traversal through layer inheritance without manual merging
*   **Efficient Scanning:** Direct iteration over inherited BTrees eliminates complex merge logic
*   **Memory Efficiency:** Copy-on-write semantics minimize memory usage for read-heavy workloads

## **Usage Examples:**

### **Basic Table Operations:**

```typescript
import { Database, MemoryTableModule } from 'quereus';

const db = new Database();
// Register the module (typically done once)
db.registerModule('memory', new MemoryTableModule());

// Create a table with single-column primary key
await db.exec(`
    create table main.users(
        id integer primary key,
        name text,
        email text,
        created_at text
    );
`);

// Create a table with composite primary key
await db.exec(`
    create table main.user_sessions(
        user_id integer,
        session_id text,
        created_at text,
        expires_at text,
        primary key (user_id, session_id)
    );
`);
```

### **Secondary Indexes:**

```typescript
// Create secondary indexes for efficient querying
await db.exec("create index users_email_idx on users (email)");
await db.exec("create index users_created_idx on users (created_at desc)");

// Queries automatically use appropriate indexes
const userByEmail = await db.prepare("select * from users where email = ?").get("john@example.com");
const recentUsers = await db.prepare("select * from users order by created_at desc limit 10").all();
```

### **Transaction and Savepoint Support:**

```typescript
// Explicit transaction with savepoints
await db.exec("begin");
try {
    await db.exec("insert into users (id, name, email) values (1, 'John', 'john@example.com')");

    await db.exec("savepoint sp1");
    await db.exec("insert into users (id, name, email) values (2, 'Jane', 'jane@example.com')");

    // Rollback to savepoint, keeping John but removing Jane
    await db.exec("rollback to sp1");

    await db.exec("insert into users (id, name, email) values (3, 'Bob', 'bob@example.com')");
    await db.exec("commit"); // Commits John and Bob
} catch (error) {
    await db.exec("rollback");
}
```

### **Schema Evolution:**

```typescript
// Add new column with default value
await db.exec("alter table users add column age integer default 0");

// Create index on new column
await db.exec("create index users_age_idx on users (age)");

// Rename column (if supported by parser)
await db.exec("alter table users rename column created_at to registration_date");
```

## **Implementation Details:**

### **Layer Management:**
*   **Connection Isolation:** Each connection maintains its own read layer and optional pending transaction layer
*   **Automatic Promotion:** Committed transaction layers are automatically promoted when no longer referenced
*   **Lock-Free Reads:** Read operations don't require locks, using the connection's current layer view
*   **Efficient Writes:** Write operations use inherited BTrees to minimize data copying

### **Index Consistency:**
*   **Unified Updates:** Primary and secondary index updates are handled uniformly during mutations
*   **Inheritance Propagation:** Index changes automatically propagate through layer inheritance
*   **Schema Consistency:** Index definitions are maintained consistently across layer transitions

### **Memory Management:**
*   **Copy-on-Write Pages:** Only modified pages are copied, sharing immutable pages across layers
*   **Automatic Cleanup:** Unused layers are automatically garbage collected when no longer referenced
*   **Base Clearing:** The `clearBase()` operation makes layers independent, reducing memory overhead

## **Current Limitations:**

*   **Constraint Enforcement:** `UNIQUE` (both primary key and secondary), `NOT NULL`, `CHECK`, and `FOREIGN KEY` constraints are enforced at the engine level. Secondary `UNIQUE` constraints auto-create backing indexes for O(log n) enforcement; NULL values in UNIQUE columns are allowed per SQL standard. `DEFAULT` values are applied during DML operations. FK enforcement is on by default (`pragma foreign_keys = on`); FKs require explicit action clauses (e.g. `ON DELETE CASCADE`) to be enforced — the default action is `IGNORE`.
*   **Advanced Query Planning:** Composite index `IN` multi-seek is supported (cross-product of `IN` lists across index columns). Prefix-equality + trailing-range scans are supported on composite indexes (e.g., `WHERE a = 1 AND b > 5` on `idx(a, b)`). OR disjunctions with range predicates on the same indexed column use multi-range index seek (e.g., `WHERE price > 1000 OR price < 10`).
*   **IS NULL Optimization:** `IS NULL` on NOT NULL columns produces an `EmptyResult` plan (zero-cost short-circuit); `IS NOT NULL` on NOT NULL columns is eliminated as a tautology. For nullable columns, `IS NULL` / `IS NOT NULL` are still handled as residual filters.
*   **NULL-equality short-circuit:** A *literal* NULL equality on a seek column — `col = NULL`, single-value `col IN (NULL)`, or a NULL component of a composite/prefix seek key — is UNKNOWN under SQL three-valued logic and matches no row, so the access-path rule emits an `EmptyResult` instead of a point-seek (keeping `EXPLAIN` honest). A NULL supplied dynamically (`col = ?` bound to NULL) is unknown at plan time, so the seek is preserved and the scan-layer skips the NULL-bearing key at runtime. (Contrast `col IS NULL`, which legitimately returns the NULL rows.)
*   **Expression Indexes:** Expression-based indexes are not implemented — see `tasks/plan/2-expression-indexes.md`

## **Performance Characteristics:**

*   **Read Performance:** O(log n) for indexed lookups, O(n) for full scans
*   **Write Performance:** O(log n) for inserts/updates with copy-on-write overhead only for modified pages
*   **Memory Usage:** Efficient sharing of immutable pages across transaction layers
*   **Concurrency:** High read concurrency with minimal locking; writes are serialized per connection
*   **Transaction Overhead:** Minimal overhead for read-only transactions; moderate overhead for write transactions due to layer management

The inherited BTree architecture provides a robust foundation for high-performance in-memory SQL operations while maintaining full ACID compliance within the memory table module's scope.
