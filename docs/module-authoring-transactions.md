# Module Transactions and Connections

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

What a module owes DDL issued inside an open transaction, the `IssuerRowSources` bundle a wrapper module passes when the pending rows live outside the target module, how a module registers, evicts, reuses, and adopts connections for transaction coordination, and the sequence of calls the engine promises a registered connection. A satellite of [Virtual Table Module Authoring Guide](module-authoring.md).

## DDL inside an open transaction

`createIndex` and the row-validating `alterTable` arms (`ADD CONSTRAINT ... UNIQUE`,
`ALTER COLUMN ... SET COLLATE`, and the two value-rewriting arms `ALTER COLUMN ... SET DATA TYPE`
/ `ALTER COLUMN ... SET NOT NULL`, whose rewrite can collapse two distinct values onto one) can be
invoked while the calling connection has uncommitted writes. Two obligations follow, and both bundled modules meet them:

*   **Validate against the effective rows**, not the committed ones — the rows a `SELECT` on
    that connection would return. Scanning committed rows alone lets a duplicate the
    transaction just inserted slip past the check and land under a constraint that forbids it.
*   **Enforce the new constraint for the rest of that transaction.** A module that snapshots
    the table schema per transaction must refresh that snapshot, or the statement after the
    DDL is checked against a schema that does not yet know the constraint exists.

A third obligation is independent of open transactions: **a refused DDL call must leave
nothing behind, because the engine unwinds nothing.** `SchemaManager` registers (or
deregisters) the object in its own catalog only *after* `createIndex` / `dropIndex` /
`alterTable` returns, and re-wraps a throw without any cleanup. Everything the module already
did therefore outlives the refused statement — a physical structure it built, a catalog entry
it wrote, and above all a cached `VirtualTable.tableSchema` it swapped, which leaves the
module one schema ahead of the engine: it keeps maintaining a structure the engine never
registered, or stops maintaining one the engine still plans seeks against. Validate before
creating any physical artifact where the check allows it; where a later step can still throw,
undo the earlier ones. `StoreModuleIndex.unwindFailedIndexDdl` is the store module's shared
undo for both index arms — it records how far the statement got and runs the exact inverse,
newest step first. A cleanup step that throws must be logged and swallowed, never allowed to
replace the error the caller has to see.

Neither module makes DDL itself transactional: the catalog entry and any physical structure
are written outside the transaction coordinator, so a `ROLLBACK` discards the rows but leaves
the index behind. That is safe only because both re-validate an index entry against the live
row before returning or acting on it. See [memory-table.md](memory-table.md) § DDL and
transactions for the full statement of the boundary and what a fully-cooperating module would
do instead.

### When the pending rows live outside your module: `IssuerRowSources`

A module cannot always reach the transaction's uncommitted rows. Under the isolation layer
(`@quereus/isolation`) each connection's writes are staged in a private in-memory *overlay*;
the wrapped module holds only committed rows and cannot see the overlay at all. Its own
"effective rows" are therefore the committed rows, and the first obligation above becomes
impossible to meet unaided.

The optional last parameter of `createIndex` and `alterTable` closes that gap:

```ts
/** Re-callable; each call returns a fresh stream. */
export type EffectiveRowSource = () => AsyncIterable<Row>;

export interface IssuerRowSources {
	/** The rows the issuing transaction can SEE now. Judged for CONSTRAINT / MISMATCH. */
	readonly effective: EffectiveRowSource;
	/** The rows it would see after `rollback to` each open savepoint, oldest first. Each is
	 *  judged on its own; a violation refuses with BUSY. */
	readonly savepoints: readonly EffectiveRowSource[];
}

createIndex?(db, schemaName, tableName, indexSchema, rows?: IssuerRowSources): Promise<void>;
alterTable?(db, schemaName, tableName, change, rows?: IssuerRowSources): Promise<TableSchema>;
createIndex?(indexSchema, rows?: IssuerRowSources): Promise<void>;   // VirtualTable, instance level
savepointRowSources?(): readonly (EffectiveRowSource | undefined)[]; // VirtualTable, the staging table's half
```

**Who supplies it.** Only a wrapper module that holds the issuing connection's pending rows
outside the target module. The engine's own emitters (`CREATE INDEX`, `ALTER TABLE`) pass
nothing, so an unwrapped module keeps validating its own effective rows — and its own rollback
states — exactly as before. The isolation layer supplies its issuing connection's merged view as
`effective` (committed rows, minus the ones that connection's overlay tombstones, superseded by
the ones it rewrote, plus the ones it added) and the same merge over the overlay's rows *as they
stood at each open savepoint* as `savepoints`, read off the staging table through
`VirtualTable.savepointRowSources` (the memory module implements it; a staging module without it
cannot serve row-validating DDL under open savepoints, and the isolation layer refuses such a DDL
with `BUSY` rather than leave a rollback state unjudged). `savepointRowSources` is indexed by
savepoint depth, with `undefined` where `rollback to` that savepoint restores the staging table's
committed state — a savepoint taken before the overlay held anything; those restore the wrapped
module's committed rows and are not listed in `savepoints`. A *foreign* connection's overlay never
contributes — its staged duplicates are its own problem at commit time, exactly as a concurrent
duplicate insert would be. It is one bundle rather than two optional parameters so a wrapper
cannot hand down the effective rows and forget the rollback states.

**What the receiver must do with it.** When `rows` is present:

*   Every row-content check for the statement's *legality* — UNIQUE duplicate detection,
    collation-rekey collision detection, value-rewrite collapse detection (`SET DATA TYPE` /
    `SET NOT NULL` backfill, judged with the altered column already converted), the
    convertibility scan, the NULL scan — reads `rows.effective`. A violation there keeps the
    statement's own status: `CONSTRAINT`, or `MISMATCH` for an unconvertible value.
*   The module MUST NOT reject the DDL as a *constraint violation* over a duplicate that exists
    only in its own committed data. That duplicate may be a row the issuing transaction has
    already deleted; calling it invalid data is a false positive the caller cannot work around.
*   It MUST NOT accept it either. DDL survives a rollback on every bundled backend
    ([module-capabilities.md](module-capabilities.md#ddl-transactionality-tiers)) while the rows
    it was judged against do not, so the module then runs the *same* check, on its own, over each
    state a rollback could restore: its own committed rows (the whole-transaction rollback state,
    which only it holds) and each of `rows.savepoints`. A violation confined to such a state
    refuses with `BUSY` and the message `rolledBackRowsWouldViolate` builds — "rolling back this
    transaction would leave rows that break it. Commit the pending writes first, then retry."
    `judgeRestorableStates` runs a probe over each state and
    rewraps its `CONSTRAINT` / `MISMATCH` as that `BUSY`, so the wording lives in one place; run it
    *after* the effective pass so a visible violation keeps its own status. (A primary-key re-key
    refuses with the same status when its map-shaped tree physically cannot hold a committed pair
    — both bundled backends, for `ALTER COLUMN … SET COLLATE` on a PK member.)
*   Judge each state as the rows it will hold *after your rewrite reaches it*. Your committed
    rows are rewritten by a `SET DATA TYPE` / `SET NOT NULL` backfill, so a committed NULL under a
    usable `DEFAULT` is backfilled, not refused — and that forces the backfill even when the
    transaction itself sees no NULL. A wrapper's savepoint frame is *not* reached by your rewrite:
    judge it as-is, so a NULL there refuses under `SET NOT NULL` whether or not a `DEFAULT`
    exists. (`SET DATA TYPE` applies the conversion before judging every state; an unconvertible
    value refuses either way.)
*   Physical structures are still built from the module's OWN rows. Building an index over
    committed rows while validating over the merged view is deliberate and sound: an index entry
    with no live row behind it is harmless, because every reader resolves an entry back to its
    live row and drops it when the row is gone. The memory module documents this at its build
    site (`BaseLayer.addIndexToBase`). This covers a row a *wrapper* staged a change to. A write
    your own module buffers needs more if a later rollback must see the index agree: the store,
    run without a wrapper, queues the entries those writes owe beside them in its op log
    (`populateIndexStore`, [store.md](store.md)), because a second entry for an overwritten row
    would otherwise surface twice from a range scan.
*   Validate BEFORE creating any physical artifact, so a rejection leaves nothing behind.

Every stream is re-callable because a single `ALTER` may validate more than once (one pass per
UNIQUE constraint covering the altered column, per state). Row order is unspecified — every
consumer is a set-shaped check.

### When the engine judges the rows: `restorableRowStates`

Some row-validating DDL is judged by the engine, not the module: the existing-row CHECK scan of
`ALTER TABLE … ADD CONSTRAINT … CHECK` and of an inline CHECK on `ALTER TABLE … ADD COLUMN`
(`validateRowInvariantChecksOverExistingRows`, `schema/constraint-builder.ts`), which runs
`select 1 from <t> where not (<check>) limit 1` through the ordinary read path, and the orphan scan
of `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` and of an inline `references` on `ADD COLUMN`
(`validateAddedForeignKeyOverExistingRows`, called from the module's own `addConstraint` arm), which
runs `select 1 from <child> where <fk columns not null> and not exists (select 1 from <parent> where
<match>) limit 1`. That path sees only the effective rows, so a module whose DDL survives a rollback
reports the other states through an optional module-level hook:

```ts
interface RestorableRowStates {
	/** What a whole-transaction `rollback` restores: the committed rows. */
	readonly transaction: RestorableRows;
	/** What `rollback to` each open savepoint restores, indexed by savepoint depth; a savepoint
	 *  taken before the table had any work restores (and may share) `transaction`. */
	readonly savepoints: readonly RestorableRows[];
}

restorableRowStates?(db, schemaName, tableName, ddl): Promise<RestorableRowStates | undefined>;
```

The engine runs the effective scan first (a violation there is `CONSTRAINT`), then the very same
SQL once per distinct state with the table's rows replaced by that state's
(`Statement._rowSourceOverrides`, which plans the table as a literal over the supplied rows), and
refuses with `BUSY` through `judgeRestorableStates` when one would violate the new CHECK. Re-running
the same SQL keeps types, collations, NULL handling and the `new.` / context-variable rules
identical by construction, and because the rows are not a module scan no CHECK or assertion is
lifted from the table's declaration over them. The optimizer lifting a declared row-invariant
CHECK into a fact about every stored row is why this matters: accepted, a restored violator
would vanish from every query that filters for it.

A foreign key reads two tables, and a rollback moves both to the same point, so its scan pairs
them by rollback point instead of walking each table's states on its own. The points are the
whole-transaction rollback and each open savepoint depth; at each, the child's rows *and* the
parent's rows are replaced by the state that point restores, both overrides in one statement. A
table that reports no states (no open work, or no hook) keeps its current rows at every point; a
self-referencing key has one table, so both reads take its one state; an absent parent needs no
override, since every fully non-NULL child row is then an orphan anyway. Judging a child state
against the parent's *current* rows would be wrong both ways: a parent row the transaction
inserted would hide a committed orphan that a rollback brings back (missed violation), and a
parent deleted together with its child rows would refuse a rollback that restores both (false
refusal). A point whose two sides are both current is the effective scan and is skipped; with
neither table holding open work no second scan runs.

The contract:

*   Return `undefined` when the issuing connection has no open work on the table — every state
    then equals the effective rows, and the common case pays no second scan.
*   Read-only: no drain, no flush, no other mutation. `ADD CONSTRAINT … CHECK` calls the hook
    *before* `alterTable`; `ADD COLUMN` calls it *after* `alterTable(addColumn)`, so each state
    already carries the new column as the module wrote it into that state; a foreign key's scan
    calls it from *inside* the module's `alterTable(addConstraint)` — for the child and for the
    parent, each through the module the catalog routes that table through (the wrapper, under the
    isolation layer) — so the hook must not take a latch the module's own schema change holds.
    Rows are in the table's current column layout. A constraint being put back during a failed
    `apply schema`'s unwind (`SchemaChangeInfo.restoring`) is not judged, so the hook is not
    called for it.
*   Index `savepoints` by the database's savepoint depth so two tables' states can be paired by
    rollback point (a foreign key pairs a child's state with its parent's). A released savepoint
    has no entry.
*   A state the module holds but cannot report must refuse, not pass: the isolation layer, over
    an overlay module without `savepointRowSources`, throws `rolledBackRowsWouldViolate(ddl, …)`
    under open savepoints. `ddl` is the statement as the user wrote it (`add constraint pos
    check`, `add check`, `add column w`, `add constraint fk foreign key`, `add foreign key` — the
    last two also for an inline `references` on `ADD COLUMN`, since the module arm cannot tell the
    two statements apart).
*   A module whose DDL rolls back with its data needs no hook; one declaring
    `permitsGrandfatheredCheckViolators` is not judged at all.

The bundled implementations: the memory module reports its committed head and each open
savepoint's layer for the DDL connection; the store, unwrapped, its committed entries and each
savepoint's prefix of the coordinator's op log (nothing when it buffers nothing for the table —
and `ADD COLUMN` flushes first, so it then reports nothing); the isolation layer, when the issuer
has staged rows, the underlying's rows as `transaction` and the overlay's frames merged with them
as `savepoints`, else whatever the underlying reports.

## Connection Registration

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

**`commit()` runs under the execution mutex.** Every statement holds the mutex until its transaction has finished, commit included, so the next statement cannot start until `commit()` returns. A `commit()` that awaits a statement on the same database therefore hangs permanently: the statement waits for the mutex and the mutex waits for `commit()`. The engine cannot detect this and throw, because a re-entrant statement looks the same as an unrelated caller who should queue. Schedule that work without awaiting it, and let it run once the mutex is free. `db._isExecuting()` reports whether the mutex is held, for code that can be reached both inside and outside a statement.

**`DatabaseInternal` methods:**

| Method | Description |
|--------|-------------|
| `registerConnection(conn)` | Registers a connection for transaction management. If a transaction is active and not closing, `begin()` is called on the connection and the active savepoint stack is replayed by calling `createSavepoint(depth)` for each open depth, so subsequent `releaseSavepoint` / `rollbackToSavepoint` broadcasts targeting earlier depths are in-range on the new connection. A `begin()` that rejects rejects the registration and leaves the connection unregistered. A connection registered while a transaction is closing joins at the next begin — see [Connection lifecycle](#connection-lifecycle). |
| `unregisterConnection(id)` | Unregisters a connection. May be deferred during implicit transactions. |
| `getConnection(id)` | Gets a connection by ID. |
| `getConnectionsForTable(name)` | Gets all connections for a table. Matches the qualified name *or* the bare table name, so it can reach a same-named table in another schema. Useful for connection reuse. |
| `getAllConnections()` | Gets all active connections. |
| `removeConnectionsForTable(schema, table)` | Force-removes **every** connection registered under `schema.table`, bypassing the implicit-transaction deferral. Only correct when the table itself is going away (`destroy` / drop), where no connection under that name can still have state worth committing. The engine calls it for you on drop. |
| `removeConnection(id)` | Force-removes one connection by id, bypassing the deferral. This is the tool a `renameTable` implementation needs. |

**Evicting connections on `renameTable`:**

The engine's rename path does *not* evict connections, so a module whose connections are pinned to the old table name must evict them itself or leak one per rename. Evict **only the connections your own module created** — discriminate with `instanceof` (or a brand property) *and* an exact qualified-name match, then call `removeConnection(conn.connectionId)` on each:

```typescript
const oldQualified = `${schemaName}.${oldName}`.toLowerCase();
for (const conn of dbInternal.getAllConnections()) {
  if (conn instanceof MyConnection && conn.tableName.toLowerCase() === oldQualified) {
    dbInternal.removeConnection(conn.connectionId);
  }
}
```

Do **not** reach for `removeConnectionsForTable` here. A wrapping module — `IsolationModule` is the one in-tree — registers its own connection under the same qualified name, and that connection is the only thing that drives its staged writes to storage at `COMMIT`. A blanket name-keyed sweep deletes it, and the transaction's writes vanish while the commit reports success.

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

**Adopting a runtime-offered connection (`adoptConnection`):**

The reuse pattern above is *pull*: your `ensureConnection` looks the registry up when it happens to run. The runtime also *pushes* — when it materializes a fresh `VirtualTable` instance for a table that already has a registered connection, it offers that connection to the instance via the optional `adoptConnection` hook on `VirtualTable`, so the new instance reuses the in-flight connection (and its uncommitted transaction state) instead of opening a rival one:

```typescript
adoptConnection(connection: VirtualTableConnection): void {
  // Reject connections another module registered under the same qualified name.
  if (!(connection instanceof MyConnection)) return;
  // Reject a stale connection whose backing state no longer matches this instance
  // (e.g. a dropped-then-recreated table); adopt only when the state matches.
  if (connection.backingStore !== this.store) return;
  this.connection = connection;
}
```

Contract:

- **The module owns the accept/reject decision.** The runtime knows nothing about your connection type — it hands you the registered `VirtualTableConnection` and ignores the return value. Downcast with `instanceof` (or a brand check) and reject connections you did not create, plus connections whose backing state no longer matches this instance. Silently do nothing when you decline.
- **Ownership is not transferred.** The adopted connection stays owned by the database connection registry that registered it. Adopting it must not make this instance responsible for closing it beyond your module's existing `disconnect` contract.
- **It must be idempotent.** Calling `adoptConnection` more than once on the same instance must be safe (re-setting the same connection).

Implement the hook when a table's uncommitted state lives on the connection and a second instance of the same table within one statement must see it. Modules whose per-instance state is self-contained can omit it — a module without the hook behaves exactly as before (the runtime's optional-chain call is a no-op).

**When to use connection registration:**

- Your module maintains state that must be committed or rolled back with transactions
- You need to flush changes to persistent storage on commit
- You implement an isolation layer with overlay tables
- You coordinate with external systems that have their own transaction semantics

**Note:** The `DatabaseInternal` interface is marked `@internal` and may change between versions. It's intended for tight integration scenarios like storage backends and isolation layers.

## Connection lifecycle

> **Invariant:** [TXN-001](invariants.md#txn-001--a-registered-connection-gets-one-commit-or-rollback-per-begin)

The engine drives a connection passed to `registerConnection` through a fixed sequence of calls, which TXN-001 states. A module may rely on it, and a module that throws on a call outside it is behaving correctly. This section covers what the invariant leaves to explanation.

In range means `createSavepoint(d)` names the depth one past the deepest savepoint the connection holds (0 after `begin`), and `releaseSavepoint(d)` / `rollbackToSavepoint(d)` name a depth it holds. A release drops depth `d` and everything above it; a rollback-to keeps `d` and drops what is above it.

Three consequences shape how a module is written:

- **A connection registered while a transaction is closing receives no calls for that transaction.** Closing covers the whole of a commit or rollback: commit-time assertion and deferred-constraint evaluation, the commit loop, post-commit watchers, and the rollbacks. The connection joins at the next `begin`. Until then it reads committed rows, which is the right answer for a table the closing transaction did not write; a table it did write already has a connection, which the module should reuse. A module that writes through such a connection during a commit drives that write itself, as the isolation layer's flush does through `VirtualTable.begin` and `commit`.
- **A `begin` that rejects fails the statement that caused it, and the connection stays idle.** When the `begin` came from `registerConnection`, the connection is not left registered. When it came from the start of a transaction, the connections already begun are rolled back and the database stays in autocommit.
- **A connection removed from the registry while open gets no further calls.** `unregisterConnection`, `removeConnection` and `removeConnectionsForTable` take it out of the transaction: the engine sends it neither the `commit` nor the `rollback`. That suits a connection that holds no state of its own, or whose table is gone. Do not register the same object again afterwards; make a new connection.

The engine commits one connection ahead of its transaction in two places: a `refresh materialized view` that reshapes its table (the body's output shape changed), and an `alter table … set maintained` that retypes, recollates or tightens a column. It begins that connection again at once and replays the open savepoint depths, so the connection sees `begin`, `commit`, `begin`, and then the transaction's own `commit` or `rollback`. If the early `commit` rejects, the whole transaction is rolled back.

### Checking a module against the lifecycle

`installConnectionLifecycleCheck(db)` watches every connection `db` registers from then on and compares each call with that sequence:

```typescript
import { Database, installConnectionLifecycleCheck } from '@quereus/quereus';

const db = new Database();
const lifecycle = installConnectionLifecycleCheck(db); // before the module registers a connection
db.registerModule('mine', myModule);

await db.exec('insert into t values (1)');
lifecycle.assertClean(); // throws, listing every violation
```

A call outside the sequence is recorded in `lifecycle.violations` and then thrown, before the connection's own method runs. It is recorded as well as thrown because the engine swallows some of these throws on its error paths. `assertClean()` also fails when a registered connection is still open with no statement running and the database in autocommit. Like `installCommitStall`, the patch is permanent for the life of the database, so use one the test owns. The engine's own SQL logic tests run under the check on both the memory and the store backend.

The check sees only calls on the object passed to `registerConnection`. Calls a wrapper makes on the connections inside it — `IsolatedConnection` on its overlay and underlying connections, `StoreTable.commit` on the store's shared coordinator — are the wrapper's own business, and a wrapper that wants them checked has to check them itself. Nor does it see a connection leave the registry: one removed while open stays open in its record, so registering that object again in a later transaction is reported as a `begin` on an open connection.
