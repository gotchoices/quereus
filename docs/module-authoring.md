# Virtual Table Module Authoring Guide

This guide provides documentation for implementing virtual table modules in Quereus. It covers the architecture, optimization integration, and best practices for module authors.

## Overview

Virtual table modules are the primary extension point for custom data sources in Quereus. A module implements the `VirtualTableModule` interface and provides instances of `VirtualTable` that handle data access, updates, and query optimization.

### Key Concepts

- **Module**: Factory that creates table instances; implements `create()`, `connect()`, and optimization methods
- **Table Instance**: Represents a specific table; implements `query()`, `update()`, and transaction support
- **Optimization Integration**: Modules communicate capabilities to the optimizer via `BestAccessPlan` API or `supports()` method
- **Retrieve Boundary**: The optimizer wraps all table references in `RetrieveNode`, marking where data transitions from module execution to Quereus execution

## Architecture: Retrieve-Based Push-down

### The Retrieve Node Boundary

Every table reference is automatically wrapped in a `RetrieveNode` at build time:

```
RetrieveNode (optimizer boundary)
  └─ pipeline: RelationalPlanNode (module-supported operations)
      └─ TableReferenceNode (leaf table reference)
```

**Key principle**: Operations inside the `RetrieveNode` pipeline are executed by the module; operations above are executed by Quereus.

### How Push-down Works

1. **Predicate Normalization**: The optimizer normalizes filter predicates and extracts constraints
2. **Supported-only Placement**: Only predicates the module can handle are pushed into the `Retrieve` pipeline
3. **Residual Predicates**: Unsupported predicates remain above the `Retrieve` boundary
4. **Binding Capture**: Parameters and correlated column references are captured in `Retrieve.bindings`

Example:
```sql
select * from users where id = 1 and name like 'A%' and age > 30;
```

If the module supports equality on `id` but not LIKE or range comparisons:
```
Filter (name LIKE 'A%' AND age > 30)  ← Quereus executes
  └─ Retrieve
      └─ Filter (id = 1)              ← Module executes
          └─ TableReference
```

### Retrieve Node Structure

The `RetrieveNode` contains:
- **pipeline**: The operations the module will execute (initially just `TableReferenceNode`, but grows as predicates are pushed down)
- **bindings**: Parameters and correlated column references captured from pushed-down operations

At runtime:
1. Bindings are evaluated to produce concrete values
2. The module receives these values via `FilterInfo.args` (for index-based) or as part of the plan (for query-based)
3. The module executes the pipeline and returns rows
4. Quereus applies any residual operations above the `Retrieve` boundary

### Supported-only Placement Policy

The optimizer enforces a strict policy: **only operations the module can handle are placed inside the Retrieve boundary**. This is determined by:

1. **For query-based modules**: The `supports()` method returns a result
2. **For index-based modules**: The `getBestAccessPlan()` method marks filters as handled via `handledFilters` array

If a module claims to handle an operation but fails at runtime, data corruption can result. Always be conservative in capability reporting.

## Module Capability APIs

Modules communicate their capabilities through two complementary interfaces:

### 1. Query-Based Push-down (Advanced)

Implement `supports()` to analyze entire query pipelines:

```typescript
interface VirtualTableModule {
  supports?(node: PlanNode): SupportAssessment | undefined;
}

interface SupportAssessment {
  cost: number;           // Module's cost estimate
  ctx?: unknown;          // Opaque context for runtime
}
```

**When to use**: SQL federation, document databases, remote APIs that can execute complex queries.

**Important**: If `supports()` returns a result, the module **must** implement `executePlan()` to execute the pipeline. The optimizer will call `executePlan()` at runtime with the same plan node and context.

**Example**: A PostgreSQL federation module analyzing a Filter+Project+Sort pipeline:
```typescript
supports(node: PlanNode): SupportAssessment | undefined {
  if (node instanceof FilterNode) {
    // Check if predicate is SQL-compatible
    if (this.canTranslatePredicate(node.predicate)) {
      return { cost: 10, ctx: { sql: this.generateSQL(node) } };
    }
  }
  return undefined; // Can't handle this pipeline
}

// At runtime, executePlan() receives the same node and ctx
async* executePlan(db: Database, node: PlanNode, ctx?: unknown): AsyncIterable<Row> {
  const sql = (ctx as any)?.sql;
  // Execute the SQL against the remote database
  const results = await this.executeRemoteSQL(sql);
  for (const row of results) {
    yield row;
  }
}
```

### 2. Index-Based Access (Standard)

Implement `getBestAccessPlan()` to expose index capabilities:

```typescript
interface VirtualTableModule {
  getBestAccessPlan?(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult;
}

interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: OrderingSpec;
  limit?: number | null;
  estimatedRows?: number;
}

interface BestAccessPlanResult {
  handledFilters: readonly boolean[];  // Which filters the module handles
  cost: number;                        // Cost estimate
  rows: number | undefined;            // Cardinality estimate
  providesOrdering?: readonly OrderingSpec[]; // If module provides ordering
  isSet?: boolean;                     // If result is guaranteed unique
  explains?: string;                   // Free-text explanation for debugging
  residualFilter?: (row: any) => boolean; // Optional JS filter for residual predicates

  // Optional monotonic-storage advertisements. The optimizer lifts these onto
  // the physical leaf node's `physical.monotonicOn` / `physical.accessCapabilities`
  // and downstream rules use them to license rewrites that depend on
  // total-order emit (streaming asof, monotonic merge join, ordinal-seek
  // pushdown). Not propagated through pass-through nodes.
  monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
  supportsOrdinalSeek?: boolean;       // Implies monotonicOn; O(log N) seek to kth row
  supportsAsofRight?: boolean;         // Implies monotonicOn; forward-only repositioning
}
```

**Capability contracts**:
- `monotonicOn` is the leaf's natural emit order (storage property, not request-dependent). Stronger than `providesOrdering` — implies a total order with no gaps in coverage.
- `supportsOrdinalSeek` enables the `monotonic-limit-pushdown` rule: when advertised, the runtime may stamp `FilterInfo.offset`/`FilterInfo.limit` and the module must seek directly to the kth monotonic row (see `query()` contract above). Modules that advertise `supportsOrdinalSeek` but ignore the directives at runtime degrade to a streaming `LIMIT` (the rule's slice operator enforces the cap above the leaf).
- `supportsAsofRight` enables the `lateral-top1-asof` rule: forward-only repositioning per left row.

**When to use**: Most modules (in-memory tables, file-based storage, traditional indexes).

**Example**: Memory table with primary key index:
```typescript
getBestAccessPlan(
  db: Database,
  tableInfo: TableSchema,
  request: BestAccessPlanRequest
): BestAccessPlanResult {
  // Check for equality on primary key
  const pkConstraints = request.filters.filter(f =>
    f.op === '=' && f.columnIndex === 0 // PK is column 0
  );

  if (pkConstraints.length > 0) {
    return {
      handledFilters: request.filters.map(f => pkConstraints.includes(f)),
      cost: 1,                    // Very cheap
      rows: 1,                    // Unique lookup
      isSet: true,                // Guarantees unique rows
      explains: 'Primary key index seek'
    };
  }

  // Fall back to full scan
  return {
    handledFilters: request.filters.map(() => false),
    cost: this.data.length,
    rows: this.data.length,
    explains: 'Full table scan'
  };
}
```

### 3. Concurrency Mode (Parallel Runtime)

When a parallel-runtime consumer (e.g. fan-out lookup join) wants to issue
multiple vtab calls in flight on a single connection, it consults the
module's declared `concurrencyMode`. By default, modules opt out of
parallelism — the runtime acquires a per-connection lock so calls are
serialized.

```typescript
interface VirtualTableModule {
  readonly concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant';
}
```

| Mode | Per-connection guarantee from the module |
| --- | --- |
| `'serial'` (default) | Nothing. Runtime serializes via `acquireConnectionLock`. |
| `'reentrant-reads'` | Concurrent `query()` is safe; writes still serialize. |
| `'fully-reentrant'` | All operations are safe to interleave on one connection. |

**Default is `'serial'`** — the safe choice for any module that hasn't
been audited. The cost is that parallel consumers fall back to lock
serialization on shared connections, defeating parallelism for that
module. The declaration is the knob that actually buys parallelism;
nothing else needs to change.

**Upgrading a module:**

1. Identify the connection-level state mutated by `query()`, `update()`,
   savepoints, etc. If `query()` snapshots its working set at call entry
   and never touches state another call writes, `'reentrant-reads'` is
   safe.
2. Walk through the worst-case interleavings under
   single-threaded JS: torn reads can only happen if a write publishes
   state in more than one statement step. Atomic single-statement
   pointer swaps are safe; multi-step state machines aren't.
3. For `'fully-reentrant'`, the same holds for writes. This is a much
   higher bar and is usually not worth it — `'reentrant-reads'` is the
   common upgrade target.

The runtime helpers live at `vtab/concurrency.ts`:

```typescript
import { getModuleConcurrencyMode, acquireConnectionLock } from '@quereus/quereus';

const mode = getModuleConcurrencyMode(module);
if (mode === 'serial') {
  const release = await acquireConnectionLock(connection);
  try {
    for await (const row of vtab.query(filterInfo)) yield row;
  } finally {
    release();
  }
}
```

Memory vtab declares `'reentrant-reads'`: `query()` captures the
connection's read or pending layer at call entry and iterates that
captured BTree, so concurrent reads on one connection see consistent,
non-mutating snapshots. Writes serialize because, once a transaction is
open, subsequent writes mutate the existing pending layer's BTree in
place — `'fully-reentrant'` would require either fresh-per-write layers
or an iterator-safe mutation path. Layered stores, isolation wrappers,
and persistent plugins stay default until their owners audit them.

## Runtime Execution Modes

### Query-Based Execution

If module implements `supports()`, implement `executePlan()`:

```typescript
interface VirtualTable {
  executePlan?(
    db: Database,
    plan: PlanNode,
    ctx?: unknown
  ): AsyncIterable<Row>;
}
```

The module receives the entire pipeline and executes it within its own context.

### Index-Based Execution

If module implements `getBestAccessPlan()`, implement `query()`:

```typescript
interface VirtualTable {
  query?(filterInfo: FilterInfo): AsyncIterable<Row>;
}

interface FilterInfo {
  args: SqlValue[];           // Constraint values
  argIndices: number[];       // Which constraints are provided
  limit?: number;             // Optional row cap (LIMIT pushdown)
  offset?: number;            // Optional kth-row seek (only valid when supportsOrdinalSeek was advertised)
}
```

The module receives individual constraints and returns matching rows.

**Pushdown directives**: `FilterInfo.limit` is a soft row cap — modules may stop emitting once `limit` rows have been yielded. `FilterInfo.offset` is a seek-to-kth-row directive and is only set when the access plan advertised `supportsOrdinalSeek` for this query — modules without ordinal-seek support can ignore both fields safely (a streaming guard above the leaf still enforces correctness).

## Optimization Integration Points

### Physical Property Computation

Modules should communicate:
- **Cardinality**: Estimated row count
- **Ordering**: If module provides sorted output
- **Uniqueness**: If result is guaranteed unique

These properties enable the optimizer to make better decisions about join order, aggregation strategy, and materialization.

### Binding Capture

When predicates are pushed into the `Retrieve` pipeline, parameters and correlated column references are captured:

```typescript
// Query with parameter
select * from users where id = ?;

// Retrieve.bindings contains: [ParameterReference(1)]
// At runtime, the module receives the parameter value via FilterInfo.args
```

This enables efficient parameterized queries and correlated subqueries.

## Transaction Support

Modules can implement transaction methods for ACID compliance:

```typescript
interface VirtualTable {
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(index: number): Promise<void>;
  rollbackTo?(index: number): Promise<void>;
  release?(index: number): Promise<void>;
}
```

See [runtime.md](runtime.md) for transaction semantics.

### Connection Registration

For modules that need to participate in the database's transaction coordination (e.g., receiving `commit()` and `rollback()` calls when the database commits or rolls back), you must register connections with the database.

The `DatabaseInternal` interface exposes internal methods for this purpose:

```typescript
import type { Database, DatabaseInternal, VirtualTableConnection } from '@quereus/quereus';

class MyTable extends VirtualTable {
  private connection: MyConnection | null = null;

  private async ensureConnection(): Promise<MyConnection> {
    if (!this.connection) {
      this.connection = new MyConnection(this.tableName);
      
      // Register with database for transaction coordination
      await (this.db as DatabaseInternal).registerConnection(this.connection);
    }
    return this.connection;
  }
}
```

**`DatabaseInternal` methods:**

| Method | Description |
|--------|-------------|
| `registerConnection(conn)` | Registers a connection for transaction management. If a transaction is already active, `begin()` is called on the connection and the active savepoint stack is replayed by calling `createSavepoint(depth)` for each open depth, so subsequent `releaseSavepoint` / `rollbackToSavepoint` broadcasts targeting earlier depths are in-range on the new connection. |
| `unregisterConnection(id)` | Unregisters a connection. May be deferred during implicit transactions. |
| `getConnection(id)` | Gets a connection by ID. |
| `getConnectionsForTable(name)` | Gets all connections for a table. Useful for connection reuse. |
| `getAllConnections()` | Gets all active connections. |

**Connection reuse pattern:**

Before creating a new connection, check if one already exists for the table:

```typescript
private async ensureConnection(): Promise<MyConnection> {
  if (!this.connection) {
    // Check for existing connection to reuse
    const dbInternal = this.db as DatabaseInternal;
    const existing = dbInternal.getConnectionsForTable(this.tableName);
    
    if (existing.length > 0 && existing[0] instanceof MyConnection) {
      this.connection = existing[0];
    } else {
      // Create and register new connection
      this.connection = new MyConnection(this.tableName);
      await dbInternal.registerConnection(this.connection);
    }
  }
  return this.connection;
}
```

**When to use connection registration:**

- Your module maintains state that must be committed or rolled back with transactions
- You need to flush changes to persistent storage on commit
- You implement an isolation layer with overlay tables
- You coordinate with external systems that have their own transaction semantics

**Note:** The `DatabaseInternal` interface is marked `@internal` and may change between versions. It's intended for tight integration scenarios like storage backends and isolation layers.

## Schema Changes (`SchemaChangeInfo`)

When `ALTER TABLE` is executed, the engine calls `VirtualTable.alterSchema(changeInfo)` with a `SchemaChangeInfo` discriminated union describing the change. The current variants are:

```typescript
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> };
```

### `alterPrimaryKey`

The `alterPrimaryKey` variant is dispatched for `ALTER TABLE ... ALTER PRIMARY KEY (...)`. Each entry in `newPkColumns` gives the column `index` (0-based position in the table's column list) and whether the column is `desc`. An empty array means the table reverts to an implicit key.

Modules that can re-key in place should handle the change directly and return an updated `TableSchema`. Modules that **cannot** re-key in place should throw `QuereusError(..., StatusCode.UNSUPPORTED)` — the runtime treats this as a signal to fall back to a generic table rebuild. The rebuild copies all rows from the old table to a new table with the updated PK definition, then swaps it in place.

## Best Practices

### 1. Accurate Cost Estimation

Provide realistic cost estimates in `BestAccessPlan`:
- **Sequential scan**: `O(n)` where n is row count
- **Index seek**: `O(log n)` for balanced indexes
- **Index scan**: `O(k + log n)` where k is result size

Inaccurate costs lead to suboptimal query plans.

### 2. Conservative Capability Reporting

Only report capabilities you can reliably implement:
- If `supports()` returns a result, the module must execute that pipeline correctly
- If `getBestAccessPlan()` marks a filter as handled, the module must apply it
- Incorrect reporting causes silent data corruption

### 3. Efficient Filtering

Push as much filtering as possible into the module:
- Reduces data transferred to Quereus
- Enables module-specific optimizations (indexes, partitioning)
- Improves overall query performance

### 4. Proper Cardinality Estimation

Accurate row count estimates enable:
- Better join order selection
- Appropriate aggregation strategy
- Correct materialization decisions

### 5. Preserve Attribute IDs

When implementing `xExecutePlan()`, preserve the attribute IDs from the input plan:
- Column references use stable attribute IDs
- Transformations must maintain these IDs
- See [runtime.md](runtime.md) for attribute system details

## Common Patterns

### Simple In-Memory Table

```typescript
class SimpleTable extends VirtualTable {
  constructor(private data: Row[]) { super(...); }

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    return {
      handledFilters: req.filters.map(() => false),
      cost: this.data.length,
      rows: this.data.length
    };
  }

  async* query(): AsyncIterable<Row> {
    for (const row of this.data) yield row;
  }

  async update(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) this.data.push(values);
    return undefined;
  }

  async disconnect(): Promise<void> {}
}
```

### Indexed Table

```typescript
class IndexedTable extends VirtualTable {
  private index = new Map<SqlValue, Row[]>();

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    const eqFilters = req.filters.filter(f => f.op === '=' && f.columnIndex === 0);
    if (eqFilters.length > 0) {
      return {
        handledFilters: req.filters.map(f => eqFilters.includes(f)),
        cost: 1,
        rows: 1,
        isSet: true,
        explains: 'Index equality seek'
      };
    }
    return {
      handledFilters: req.filters.map(() => false),
      cost: 100,
      rows: 100,
      explains: 'Full table scan'
    };
  }

  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (filterInfo.argIndices.length > 0) {
      const key = filterInfo.args[0];
      yield* this.index.get(key) || [];
    } else {
      for (const rows of this.index.values()) {
        yield* rows;
      }
    }
  }

  async update(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) {
      const key = values[0];
      if (!this.index.has(key)) this.index.set(key, []);
      this.index.get(key)!.push(values);
    }
    return undefined;
  }

  async disconnect(): Promise<void> {}
}
```

## Statistics for Cost-Based Optimization

Virtual table modules can optionally provide statistics for the optimizer's cost model. Implement `getStatistics()` on your `VirtualTable` subclass to report row counts, per-column distinct values, min/max, and histograms.

```typescript
import type { TableStatistics, ColumnStatistics } from '@quereus/quereus';

class MyTable extends VirtualTable {
  getStatistics(): TableStatistics {
    return {
      rowCount: this.data.length,
      columnStats: new Map([
        ['id', { distinctCount: this.data.length, nullCount: 0 }],
        ['name', { distinctCount: this.uniqueNames, nullCount: 0 }],
      ]),
    };
  }
}
```

When `getStatistics()` is implemented, the `ANALYZE` command calls it directly. Otherwise, ANALYZE performs a full scan to collect statistics. Statistics are cached on `TableSchema.statistics` and consumed by `CatalogStatsProvider` for selectivity estimation.

## Update results and REPLACE displacement

`update()` returns an `UpdateResult`. On success (`{ status: 'ok', … }`) it may report rows that this same call displaced via `OR REPLACE` conflict resolution, through two **independent, additive, optional** channels. A module that reports neither behaves exactly as it would have before the channels existed — so the field is purely opt-in.

```typescript
type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

- **`replacedRow`** — the row displaced at the **same primary key** by a PK-collision REPLACE (the new row landed on an occupied PK; the old row had the same PK). The executor models it as an update-in-place of that PK slot: change-tracking as `update(replacedRow → newRow)` on the INSERT path (or `delete(replacedRow)` on a UPDATE move), with foreign-key actions fired as a *delete* of the old image.
- **`evictedRows`** — rows at **other primary keys** fully removed because REPLACE resolved a **non-PK UNIQUE** conflict for this same `update()` call. Report them in **user-facing schema** (no internal/overlay columns). The executor models **each** as a full DELETE — change-tracking, row-time materialized-view maintenance, foreign-key `ON DELETE` actions (CASCADE / SET NULL / …), and a delete event — fired **before** the new row's own bookkeeping, matching the substrate's evict-then-write order.

Report `evictedRows` whenever your `update()` internally deletes a row at a different PK to resolve a secondary-UNIQUE REPLACE; otherwise those cross-cutting effects (FK cascades, change subscriptions, events, covering-MV backing maintenance) silently do **not** run for the evicted row. Detection is necessarily module-specific (each module enumerates its current rows its own way), but the maintenance and cascades are **not** — reporting the eviction lets the engine's single post-write pipeline handle them uniformly. The two channels are independent and may both be present in principle; the executor handles each cleanly.

> **`ON DELETE RESTRICT` / `NO ACTION` enforcement for evictions.** The executor enforces FK `RESTRICT` / `NO ACTION` for an evicted row alongside the FK *actions* (`CASCADE` / `SET NULL` / `SET DEFAULT`). The substrate has already physically deleted the row by the time it reports `evictedRows`, so there is no pre-mutation point to block at; instead the executor runs the transitive RESTRICT scan **post-eviction** (the child rows it keys off remain) and, on a violation, throws — the statement-scope savepoint then rolls back, unwinding both the eviction and the writing row. A secondary-UNIQUE REPLACE that would orphan a `RESTRICT` (or default `NO ACTION`) child therefore fails the statement and leaves data unchanged, matching SQLite. Enforced on the key-based memory, direct-store, and isolation-wrapped substrates; rowid-chained backends (lamina) remain out of scope (the post-eviction transitive recursion cannot dereference the already-removed parent), mirroring the documented SET-DEFAULT recursion gap.

## Mutation Statements

Virtual table modules can opt-in to receive deterministic mutation statements for each row-level operation. This enables replication, audit logging, and change data capture with guaranteed reproducibility.

### Overview

When a module sets `wantStatements: true`, Quereus provides a `mutationStatement` string with each `update()` call. This statement:

- Represents the **bottom-level mutation** at the VirtualTable.update() level (not the top-level DML statement)
- Contains all values as **literals** (no parameters; non-deterministic source expressions like `random()` or `datetime('now')` are already resolved to the concrete per-row values the engine evaluated)
- Includes **resolved mutation context** values as literals in the WITH CONTEXT clause
- Is the **audit / transport encoding** of the resolved per-row primitive that hit the module; replay is the act of applying that primitive at the same module boundary on another instance — not re-parsing the captured SQL through the full DML pipeline (re-execution would re-fire CHECKs, default evaluation, and generated-column computation, which is explicitly not the supported replay path)

### Module Opt-In

Modules enable mutation statements by setting a property:

```typescript
class MyReplicatedTable extends VirtualTable {
  // Opt-in to mutation statements
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // args.mutationStatement contains the deterministic SQL statement
    if (args.mutationStatement) {
      await this.replicationLog.append(args.mutationStatement);
    }

    // Perform the actual mutation
    return this.performUpdate(args);
  }
}
```

### Statement Format

Mutation statements use Quereus SQL syntax with all values as literals:

**INSERT Example:**
```sql
-- Original statement with parameters
insert into orders (id, amount) values (:id, :amount)

-- Logged mutation statement (per row)
insert into orders (id, amount) values (1, 100)
```

**INSERT with Mutation Context:**
```sql
-- Original statement
insert into orders (id, amount, created_at)
with context now = datetime('now')
values (1, 100, now)

-- Logged mutation statement (context resolved to literal)
insert into orders (id, amount, created_at) with context now = '2024-01-15T10:30:00Z' values (1, 100, '2024-01-15T10:30:00Z')
```

**UPDATE Example:**
```sql
-- Original statement
update users set name = :newName where id = :userId

-- Logged mutation statement (per row)
update users set name = 'Alice' where id = 1
```

**DELETE Example:**
```sql
-- Original statement
delete from sessions where user_id = :userId

-- Logged mutation statement (per row)
delete from sessions where user_id = 42 and session_id = 'abc123'
```

### Determinism Guarantees

The mutation statement system ensures determinism by:

1. **Resolving Execution Parameters**: All `:name` and `?` parameters are replaced with their literal values
2. **Resolving Mutation Context**: All context variables are evaluated once per statement and emitted as literals
3. **Resolving Defaults / Generated Columns**: DEFAULT and `GENERATED ALWAYS AS` expressions are evaluated per row and emitted as literal values — this is true even when the source expressions contain non-deterministic functions (allowed under `pragma nondeterministic_schema = true`; see [Determinism Validation](runtime.md#determinism-validation))
4. **Preserving Order**: Mutations are logged in the order they're applied to the virtual table

Replay then means: take the captured primitive and re-apply it at the module boundary (e.g. feed `mutationStatement` rows back through `vtab.update()` on the replica), not re-execute the SQL through the full DML pipeline. The atomicity of the original commit — including deferred CHECKs that were evaluated once at commit time — is preserved by replaying the transaction's writes as a unit.

### Use Cases

**Replication:**
```typescript
class ReplicatedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Send mutation to replicas
    await this.replicator.broadcast(args.mutationStatement!);

    // Apply locally
    return this.storage.update(args);
  }
}
```

**Audit Logging:**
```typescript
class AuditedTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Log mutation with timestamp and user
    await this.auditLog.record({
      timestamp: Date.now(),
      user: this.currentUser,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

**Change Data Capture:**
```typescript
class CDCTable extends VirtualTable {
  wantStatements = true;

  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Publish change event
    await this.eventBus.publish({
      table: this.tableName,
      operation: args.operation,
      statement: args.mutationStatement!
    });

    return this.storage.update(args);
  }
}
```

## Database-Level Event System

Quereus provides a unified event system at the database level that aggregates events from all modules. This enables reactive patterns where applications can subscribe to data and schema changes without knowing which specific modules are being used.

### How It Works

1. **Event Aggregation**: The `Database` class provides `onDataChange()` and `onSchemaChange()` methods that receive events from all modules
2. **Native Module Events**: Modules that implement their own event emitter (via `getEventEmitter()`) have their events automatically forwarded to the database level
3. **Automatic Events**: For modules without native event support, the engine automatically emits events after successful DML and DDL operations
4. **Transaction Batching**: Events are batched during transactions and only delivered after successful commit; on rollback, events are discarded
5. **Savepoint Support**: Events respect savepoint semantics - `ROLLBACK TO SAVEPOINT` discards events from that savepoint forward, while `RELEASE SAVEPOINT` merges them into the parent transaction

### Event Types

**Data Change Events** (`DatabaseDataChangeEvent`):
```typescript
interface DatabaseDataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  moduleName: string;       // Which module raised this event
  schemaName: string;
  tableName: string;
  key?: SqlValue[];         // Primary key values
  oldRow?: Row;             // Previous values (update/delete)
  newRow?: Row;             // New values (insert/update)
  changedColumns?: string[]; // Column names that changed (update only)
  remote: boolean;          // true if from sync/remote source, false for local
}
```

**Schema Change Events** (`DatabaseSchemaChangeEvent`):
```typescript
interface DatabaseSchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'column';
  moduleName: string;       // Which module raised this event
  schemaName: string;
  objectName: string;
  columnName?: string;      // For column operations
  ddl?: string;             // DDL statement if available
  remote: boolean;          // true if from sync/remote source
}
```

### Subscribing to Events

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Subscribe to data changes
const unsubData = db.onDataChange((event) => {
  console.log(`${event.type} on ${event.schemaName}.${event.tableName}`);
  console.log(`Module: ${event.moduleName}, Remote: ${event.remote}`);
  
  if (event.type === 'update' && event.changedColumns) {
    console.log('Changed columns:', event.changedColumns);
  }
});

// Subscribe to schema changes
const unsubSchema = db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
});

// Unsubscribe when done
unsubData();
unsubSchema();
```

### Module Integration

#### For Modules with Native Events

If your module needs fine-grained control over event emission (e.g., for remote change tracking), implement `getEventEmitter()`:

```typescript
class MyModule implements VirtualTableModule<MyTable, MyConfig> {
  private eventEmitter = new DefaultVTableEventEmitter();
  
  getEventEmitter(): VTableEventEmitter {
    return this.eventEmitter;
  }
  
  // Your create/connect/destroy implementations...
}

class MyTable extends VirtualTable {
  constructor(private emitter: VTableEventEmitter, ...) {
    super(...);
  }
  
  getEventEmitter(): VTableEventEmitter {
    return this.emitter;
  }
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Perform the update...
    const result = await this.performUpdate(args);
    
    // Emit event with remote flag based on your logic
    this.emitter.emitDataChange?.({
      type: args.operation,
      schemaName: this.schemaName,
      tableName: this.tableName,
      key: this.extractKey(args),
      oldRow: args.operation !== 'insert' ? args.oldKeyValues : undefined,
      newRow: result,
      remote: this.isRemoteChange(), // Your logic for determining remote
    });
    
    return result;
  }
}
```

#### For Modules without Native Events

If your module doesn't need custom event logic (e.g., remote change tracking), simply don't implement `getEventEmitter()`. The engine will automatically emit events for all successful DML operations. These auto-emitted events:

- Have `remote: false` (local changes only)
- Include all event fields (`key`, `oldRow`, `newRow`, `changedColumns`)
- Are batched within transactions and delivered after commit

### Remote vs Local Events

The `remote` field distinguishes the origin of changes:

- **`remote: false`** (local): Changes made through SQL execution on this database instance
- **`remote: true`** (remote): Changes that originated from sync replication or external sources

For modules with native events, set `remote: true` when applying changes received from sync:

```typescript
// In your sync handler
applyRemoteChange(change: RemoteChange): void {
  // Apply the change to storage...
  
  // Emit with remote: true
  this.emitter.emitDataChange?.({
    type: change.type,
    schemaName: this.schemaName,
    tableName: this.tableName,
    key: change.pk,
    newRow: change.values,
    remote: true, // Mark as remote
  });
}
```

### Event Semantics

1. **Timing**: Events are emitted after successful commit, never during rollback
2. **Ordering**: Events are delivered in the order operations occurred within a transaction
3. **Completeness**: All successful mutations generate events (either native or auto)
4. **Listener Errors**: Exceptions in listeners are logged but don't affect other listeners
5. **Listener Order**: Listeners are called in registration order
6. **Savepoints**: Events within a savepoint are tracked separately; `ROLLBACK TO SAVEPOINT` discards those events while `RELEASE SAVEPOINT` merges them into the parent

### Event Ordering Guarantees

When events are flushed after a commit:

- **Schema events are emitted before data events.** This ensures listeners see table creation before insertions into that table.
- **Within each category** (schema or data), events from nested savepoints are flattened into the parent transaction in the order they occurred.
- **Cross-layer chronological order may not be preserved.** If a transaction creates a table and then inserts data, the schema event fires first, then the data event — but if the transaction performs schema changes interleaved with data changes, the relative ordering between the two categories is not guaranteed to match wall-clock order.

### Listener Memory Management

Listeners hold strong references. Failing to unsubscribe causes the listener (and anything it closes over) to remain in memory for the lifetime of the `Database` instance.

**Best practices:**

- **Always call the returned unsubscribe function** when the listener is no longer needed. Store the unsubscribe function and call it in your component's cleanup or teardown path.
- **Clean up before discarding the Database instance.** Although `db.close()` removes all listeners internally, relying on that means leaked listeners persist until close. Explicitly unsubscribe to make resource ownership clear.
- **Use `setMaxListeners(n)`** to adjust the warning threshold if your application legitimately registers many listeners. Set to `0` to disable the warning. The default limit is 100 per event type — exceeding it logs a warning that may indicate a listener leak.

## See Also

- [Optimizer Documentation](optimizer.md) - Detailed optimization architecture
- [Runtime Documentation](runtime.md) - Execution model and context system
- [Plugins Documentation](plugins.md) - Plugin packaging and discovery

