description: When many separate statements write rows that share one value of an indexed column, such as a status flag, an in-memory table slows down and uses memory in proportion to the square of the number of statements, because each statement copies the whole list of rows filed under that value.
architecture: docs/memory-table.md#performance-characteristics
files:
  - packages/quereus/src/vtab/memory/index.ts               # addEntry / removeEntry — inherited entry copied as `new Map(existing.primaryKeys)`; MemoryIndexEntry layout; ownedEntries; getSortedPrimaryKeys
  - packages/quereus/src/vtab/memory/types.ts               # MemoryIndexEntry
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts    # secondary-index scans read entry.primaryKeys
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # recordUpsert / recordDelete / reindexOwnWrites drive addEntry/removeEntry per layer
  - packages/quereus/src/vtab/memory/layer/manager.ts       # checkUniqueViaIndex reads entries
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The fix changes the secondary-index entry layout that scans, UNIQUE checks and the isolation layer's merge all read, which is a broad change for a cost that only bites once thousands of statements write the same indexed value.
----
# Copy-on-write of a secondary-index entry copies all of its primary keys

## Symptom (measured)

A memory table's secondary index stores one B-tree entry per distinct index value: a `MemoryIndexEntry` whose `primaryKeys` is a `Map` holding every primary key filed under that value. A transaction layer that writes under an index value it inherited from its parent cannot modify the parent's entry, so `MemoryIndex.addEntry` / `removeEntry` copy it first with `new Map(existingEntry.primaryKeys)`. That copy costs O(k), where k is the number of rows sharing that value. There is one layer per write statement (each autocommit statement, and each statement inside a transaction through its statement savepoint). So N statements writing the same value cost O(N·k) time. Every layer is kept for the life of the table (`bug-memory-table-retains-every-committed-layer`), so each copy is kept too, and memory is O(N·k) as well.

Measured on node v24.2.0. A table `t (id integer primary key, g integer)` with `create index t_g on t(g)` takes N prepared single-row inserts `insert into t values (?, 0)`. Every row has `g = 0`.

| N | inside one transaction | autocommit | retained heap (both) |
|---|---|---|---|
| 2,000 | 0.29 s | 0.29 s | 85 MB |
| 4,000 | 0.98 s | 0.95 s | 319 MB |
| 8,000 | 3.2 s | 3.2 s | 1,244 MB |

These numbers are with `bug-many-inserts-in-one-transaction-overflow-stack` in place. Before it, autocommit also paid a second quadratic term from the growing tree chain: 17 s at N = 8,000.

With the same index declared on `(id, g)`, so every value is distinct, the same 8,000 inserts retain 52 MB. The quadratic term is specific to repeated index values.

A second trigger: run `create index … on big(w)`, where `w` holds one value for every row, inside a transaction after 20,000 single-row statements. `TransactionLayer.adoptSchema` → `reindexOwnWrites` re-adds each layer's row under that one value, so every layer copies a Map of up to 20,000 keys. It exhausted a 4 GB heap.

The worst plausible effect is the process running out of memory on an ordinary workload: low-cardinality indexes on status, boolean, or foreign-key columns are common. (`severity` has no out-of-memory category; `wrong-result` is the nearest.)

## Root cause

The entry layout: one B-tree entry per index value, with a mutable set of primary keys inside it. Copy-on-write in inheritree clones B-tree nodes. It does not clone the values stored in them, so `MemoryIndex` has to copy the whole primary-key set itself. That is what `ownedEntries` tracks.

## Expected

A layer's write under an inherited index value costs O(log n), independent of how many rows share the value. One shape that does this is storing one B-tree entry per (index value, primary key) pair. Copy-on-write then clones only the touched nodes, `ownedEntries` and the per-entry sorted cache go away, and primary-key order within an index value comes from the B-tree order in both scan directions. That last point overlaps `debt-memory-reverse-secondary-pk-order`. UNIQUE checks would become a prefix probe, "does any entry exist with this index value", instead of a Map size check.

## Repro

Run the script described above: N prepared single-row inserts of `g = 0` with an index on `g`, at N = 2,000 / 4,000 / 8,000, forcing GC and sampling `process.memoryUsage().heapUsed`. Both memory and time grow about fourfold each time N doubles.
