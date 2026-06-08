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

## Capability negotiation surface

The `VirtualTableModule` contract signals capability three different ways, and the
behavior when a module does *not* implement a surface ranges from a clean negotiated
rejection to **silent divergence**. This section is the single inventory of every
negotiation surface: how it is signaled, what the engine substitutes when the module
omits it, and which built-in modules implement it. Module authors and reviewers should
treat it as the reference for "what happens if my module doesn't do X".

### Signaling styles

| Signaling | Members | Engine consults it? |
| --- | --- | --- |
| **Method presence** | `supports` / `executePlan`, `getBestAccessPlan`, `getMappingAdvertisements`, `createIndex` / `dropIndex`, `alterTable`, `renameTable`, `beginSchemaBatch` / `endSchemaBatch`, `notifyLensDeployment`, `shadowName` | yes, per call site (varies) |
| **Static field** | `concurrencyMode`, `expectedLatencyMs` | yes, before dispatch (the clean model) |
| **`getCapabilities()` flag** | `delegatesNotNullBackfill`, `permitsGrandfatheredCheckViolators` (live); `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` (informational) | only the first two |

The static-field model (`concurrencyMode`, see [Concurrency Mode](#3-concurrency-mode-parallel-runtime) above) is the clean exemplar: a defaulted, queryable value the engine reads *before* it dispatches, to choose its path. The [recommended pattern](#recommended-capability-negotiation-pattern) generalizes toward it.

### Classification legend

Each surface below is tagged by how its **unsupported path** behaves:

- **Negotiated rejection** — the engine consults presence (or catches a thrown `UNSUPPORTED`) and turns the unsupported case into a clean, sited error before / at dispatch.
- **Engine-side fallback** — absence has a defined behavior the engine substitutes.
- **Silent divergence** — the module no-ops a mandate it cannot meet, and the engine never learns. This is the bug class this inventory exists to surface.
- **Data-dependent throw** — the module throws `CONSTRAINT` / `MISMATCH` per the arm's contract (correct — not a gap).

### Surface inventory

| Surface | Signaling | Unsupported-path | memory | store | isolation | leveldb / indexeddb |
| --- | --- | --- | --- | --- | --- | --- |
| `create` / `connect` / `destroy` | required | n/a | ✓ | ✓ | wraps underlying | via store |
| `getBestAccessPlan` | presence | engine-side fallback (default full-scan; isolation returns a default plan when the underlying lacks it) | ✓ | ✓ | forwards | via store |
| `supports` / `executePlan` | presence (pair) | engine-side fallback (index path) — isolation **deliberately suppresses** it so the overlay sees every row | — | — | suppressed | — |
| `getMappingAdvertisements` | presence | engine-side fallback (name-match only) | ✓ tags | ✓ tags | forwards | via store |
| `createIndex` / `dropIndex` | presence | negotiated rejection (`SchemaManager.createIndex` — "does not support CREATE INDEX") | ✓ | ✓ | forwards (instance-level preferred) | via store |
| `shadowName` | presence | **dead** — declared on the interface but **never called anywhere** (see note below) | — | — | — | — |
| `alterTable` (method present) | presence | negotiated rejection (each `run*` in `runtime/emit/alter-table.ts` throws a sited `UNSUPPORTED` if absent) | ✓ | ✓ | forwards (throws if underlying lacks) | via store |
| `renameTable` | presence | engine-side fallback (schema-only rename) | ✓ | ✓ physical move | forwards + rekeys maps | via store |
| `beginSchemaBatch` / `endSchemaBatch` | presence | engine-side fallback (per-DDL commits) | n/a | ✓ | forwards | via store |
| `notifyLensDeployment` | presence | engine-side fallback (no-op) | n/a | n/a | forwards | n/a |
| `concurrencyMode` | static field | engine-side fallback (`'serial'`) | `reentrant-reads` | `serial` (default) | computed: `weaker(underlying, overlay)`, capped at `reentrant-reads` | via store |
| `expectedLatencyMs` | static field | engine-side fallback (`0`) | 0 | 0 | forwards underlying | via store |
| `getCapabilities().delegatesNotNullBackfill` | flag (live) | engine-side gate (ADD COLUMN skips `validateNotNullBackfill`) | off | off | inherits underlying | off |
| `getCapabilities().permitsGrandfatheredCheckViolators` | flag (live) | engine-side gate (`TableReferenceNode` skips the CHECK lift) | off | off | inherits underlying | off |
| `getCapabilities().{isolation,savepoints,persistent,secondaryIndexes,rangeScans}` | flag (informational) | **never consulted by engine** — asserted only in tests; isolation augments `isolation` / `savepoints` but nothing reads them | varies | varies | augments | varies |

> **`shadowName` is unwired.** It is declared on `VirtualTableModule` but is never called anywhere in the engine. Treat it as deprecated / dead — do not implement a contract around it expecting the engine to consult it.

> **Isolation wrapper asymmetry is intentional.** `IsolationModule` forwards the isolation-transparent hooks (`getBestAccessPlan`, `getMappingAdvertisements`, the batch + lens lifecycle hooks, `renameTable`, `alterTable`) but **suppresses** `supports` (so the overlay always sees every row to merge) and caps `concurrencyMode` / `expectedLatencyMs` at conservative defaults. See the **Transparent hook forwarding** paragraph in [`packages/quereus-isolation/README.md`](../packages/quereus-isolation/README.md) for the full rationale — do not restate it divergently here.

### `alterTable` sub-arms — the fine-grained mandate layer

`alterTable` presence is **one bit covering ~12 `SchemaChangeInfo` arms** (see [Schema Changes](#schema-changes-schemachangeinfo) below), each with its own mandate. This mismatch is the divergence hazard: a module can be "ALTER-capable" (the method is present) yet silently fail one arm it cannot honor. The `alterPrimaryKey` row is the model the [recommended pattern](#recommended-capability-negotiation-pattern) promotes to a universal rule: **try native → on `UNSUPPORTED` apply a defined fallback**.

| Arm | Mandate | memory | store |
| --- | --- | --- | --- |
| `addColumn` | append column; backfill; NOT-NULL gated by `delegatesNotNullBackfill` | ✓ | ✓ |
| `dropColumn` | remove slot + reindex | ✓ | ✓ |
| `renameColumn` | schema-only | ✓ | ✓ |
| `alterPrimaryKey` | re-key in place **or throw `UNSUPPORTED`** | throws `UNSUPPORTED` → engine `runAlterPrimaryKey` catches → **generic rebuild** | in-place re-key |
| `addConstraint` | materialize + validate (unique / fk) | ✓ | ✓ unique / fk; throws `UNSUPPORTED` for others |
| `dropConstraint` / `renameConstraint` | schema rewrite | ✓ | ✓ |
| `alterColumn.setNotNull` | backfill from default or throw `CONSTRAINT` | ✓ | ✓ |
| `alterColumn.setDataType` | physical convert or throw `MISMATCH` | ✓ | ✓ |
| `alterColumn.setDefault` | schema-only | ✓ | ✓ |
| `alterColumn.setCollation` (non-PK UNIQUE) | re-validate uniqueness under new collation | ✓ | ✓ |
| `alterColumn.setCollation` (**PK column**) | re-key / re-validate PK under new collation (`module.ts` setCollation contract) | ✓ re-keys | **✗ silent no-op → SILENT DIVERGENCE** (known gap; tracked by `store-pk-collate-module-capability`) |

> The PK-column `setCollation` cell is a **current** silent divergence, not an already-fixed case: the store's physical key bytes use a fixed table-level collation, so a PK-column `SET COLLATE` to a divergent collation is applied schema-only and never enforced. The `store-pk-collate-module-capability` work item introduces the per-arm negotiation (resolving the arm to `native | logical-enforce | reject`) that closes it.

### Recommended capability-negotiation pattern

These are the rules new modules and new contract points should follow. They generalize the clean models already in the tree (`concurrencyMode`, the `alterPrimaryKey` protocol) and retire the failure mode the inventory above flags.

1. **Presence-signaling is reserved for purely-additive optional hooks** whose absence is already a clean engine-side fallback (`getMappingAdvertisements`, the batch / lens lifecycle notifications). Absence there means a documented no-op — it can never diverge.

2. **Any contract point where the engine assumes a behavior must be declared and consulted before dispatch.** `concurrencyMode` is the template: a defaulted, queryable value the engine reads to choose its path. Generalize toward this, not toward more presence bits.

3. **`getCapabilities()` is the single home for binding capability gates.** The five informational flags — `isolation`, `savepoints`, `persistent`, `secondaryIndexes`, `rangeScans` — are **advisory / non-binding**: the engine does not consult them, so toggling them changes nothing about engine behavior (they are asserted only in tests, and isolation augments `isolation` / `savepoints` for its own bookkeeping). Do not be misled into treating them as gates. (Their removal / relocation is a separate code ticket; the distinction is documented here, not yet acted on.)

4. **Hard contract — no silent divergence.** A module that cannot honor an invoked `alterTable` arm MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message — **never silently no-op**. The engine maps `UNSUPPORTED` to a defined fallback (generic rebuild, schema-only, or engine-side logical enforcement) or surfaces it as a clean user error. This promotes the existing `alterPrimaryKey` protocol to a universal rule.

5. **Fine-grained ALTER negotiation.** Because `alterTable` presence is one coarse bit, a module advertises per-arm support that the engine consults at the relevant `run*` call site (the surface `store-pk-collate-module-capability` introduces — e.g. resolving a PK-column `setCollation` to `native | logical-enforce | reject`). New arms adopt the same shape as needs arise — incremental, not a giant up-front descriptor.

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

When `ALTER TABLE` performs a data-affecting change, the engine calls

```typescript
VirtualTableModule.alterTable(db, schemaName, tableName, change): Promise<TableSchema>
```

passing a `SchemaChangeInfo` discriminated union as `change` and registering the returned `TableSchema` in the catalog. This is a **module-level** hook (not a `VirtualTable.alterSchema` method — that older entry point no longer exists). The dispatch lives in `runtime/emit/alter-table.ts`: each `run*` helper resolves the change and, if `module.alterTable` is absent, throws a sited `QuereusError(StatusCode.UNSUPPORTED)`. `ALTER TABLE ... RENAME TO` is schema-only and routes through the separate `renameTable` hook instead.

The current arms of the union (`vtab/module.ts`):

```typescript
export type SchemaChangeInfo =
	| { type: 'addColumn'; columnDef: ColumnDef; backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue> }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| { type: 'dropConstraint'; constraintName: string }
	| { type: 'renameConstraint'; oldName: string; newName: string }
	| { type: 'alterColumn'; columnName: string;
	    setNotNull?: boolean; setDataType?: string; setDefault?: Expression | null; setCollation?: string };
```

### Per-arm mandate

Each arm carries its own contract. A module that implements `alterTable` is responsible for every arm it is handed — see the [`alterTable` sub-arm table](#altertable-sub-arms--the-fine-grained-mandate-layer) for the implementation status of the built-in modules.

| Arm | Mandate |
| --- | --- |
| `addColumn` | Append the column and backfill existing rows. A literal / NULL default is bulk-written; a non-foldable default (e.g. `new.<col>`) arrives as `backfillEvaluator`, which the module must call **per existing row**. NOT-NULL backfill rejection is gated by the `delegatesNotNullBackfill` capability. |
| `dropColumn` | Remove the column slot and reindex remaining columns. |
| `renameColumn` | Schema-only rename (no row migration). |
| `alterPrimaryKey` | Re-key in place **or** throw `UNSUPPORTED` (see below). |
| `addConstraint` | Materialize and validate the constraint (UNIQUE / FK) against existing rows; throw `CONSTRAINT` on a violation. |
| `dropConstraint` / `renameConstraint` | Rewrite the schema (and any implicit covering index that backs a UNIQUE). No row migration. |
| `alterColumn.setNotNull` | Backfill NULLs from the column default if present, else throw `CONSTRAINT`. |
| `alterColumn.setDataType` | Schema-only if the physical type is unchanged; otherwise convert each row and throw `MISMATCH` on loss (narrowing, NaN, overflow). |
| `alterColumn.setDefault` | Schema-only — new inserts pick up the default, existing rows are untouched. |
| `alterColumn.setCollation` | Re-key / re-sort any PK / UNIQUE / index ordered by the column and re-validate uniqueness under the new collation (a set unique under `BINARY` may collide under `NOCASE` → throw `CONSTRAINT`). |

### No silent divergence

The hard rule for every arm: **a module that cannot honor the invoked change MUST throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message — never silently no-op.** A silent no-op (the store's PK-column `setCollation`, tracked by `store-pk-collate-module-capability`) leaves the catalog and the physical state diverged with the engine none the wiser; a thrown `UNSUPPORTED` lets the engine substitute a defined fallback or surface a clean user error. See the [recommended pattern](#recommended-capability-negotiation-pattern), rule 4.

### `alterPrimaryKey`

The `alterPrimaryKey` variant is dispatched for `ALTER TABLE ... ALTER PRIMARY KEY (...)`. Each entry in `newPkColumns` gives the column `index` (0-based position in the table's column list) and whether the column is `desc`. An empty array means the table reverts to an implicit key.

It is the template for the no-silent-divergence rule. Modules that can re-key in place should handle the change directly and return an updated `TableSchema`. Modules that **cannot** re-key in place should throw `QuereusError(StatusCode.UNSUPPORTED)` — `runAlterPrimaryKey` catches that specific code and falls back to a generic table rebuild that copies all rows from the old table into a new table with the updated PK definition, then swaps it in place (the memory module takes exactly this path; the store re-keys natively). Any other thrown error propagates unchanged.

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

