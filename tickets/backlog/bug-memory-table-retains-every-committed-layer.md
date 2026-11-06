description: An in-memory table keeps a small record of every write statement it has ever run, so its memory use grows with the number of statements executed rather than with the number of rows it holds, and a long-running process can eventually run out of memory.
architecture: docs/memory-table.md#memory-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # `parentLayer` (readonly) — every layer references its parent
  - packages/quereus/src/vtab/memory/layer/manager.ts       # commitTransaction, rebaseLayerOntoHead, collectPendingChanges, isLayerInUse, promoteCommittedHead, openTransactionLayersOldestFirst, validateRekeyedPrimaryKey — every walk over `getParent()`
  - packages/quereus/src/vtab/memory/layer/connection.ts    # savepoint stack; which snapshots a `rollback to` can still reach
  - docs/memory-table.md
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Most sessions are short or write little, and at roughly 1.4 KB per statement the growth only matters past hundreds of thousands of statements; cutting the parent chain touches commit, rebase and in-transaction DDL code that currently relies on walking it.
----
# Committed layers are never released

## Symptom (measured)

Each write statement against a memory table creates a `TransactionLayer`. At commit it becomes the committed head, and the next statement's layer is built with the head as its `parentLayer`. Nothing ever clears that reference, so the current head keeps every earlier layer reachable for the life of the table.

Measured on node v24.2.0 after `bug-many-inserts-in-one-transaction-overflow-stack` landed (which keeps the B-tree chain one link deep but leaves the layer chain alone). A table `t (id integer primary key, g integer)` holds one row. A prepared `update t set g = ? where id = 1` runs in autocommit, and the heap is measured after a forced GC:

| statements | layer chain length | retained heap |
|---|---|---|
| 10,000 | 10,002 | 16.2 MB |
| 20,000 | 20,002 | 30.3 MB |
| 30,000 | 30,002 | 44.1 MB |
| 40,000 | 40,002 | 58.1 MB |

That is about 1.4 KB per statement, retained for the life of the table, while the table holds one row. Single-row inserts inside one explicit transaction behave the same: about 3 KB per statement with no secondary index, and 6.5 KB with one.

The worst plausible effect is a long-running process running out of memory. (`severity` has no out-of-memory category; `wrong-result` is the nearest.)

## What each retained layer holds

The layer object itself, its `ownWrites` log, its `pendingChanges` event log (when change tracking is on), the B-tree nodes it cloned on write, and its `MemoryIndex` wrappers. Since the tree-chain fix, no tree reads through an older layer: each frozen layer's trees are detached from their base. So the retention comes only from the layer-level `parentLayer` references.

## What still walks the layer chain

These are the constraints on cutting it:

- Inside an open transaction, `commitTransaction` gathers events (`collectPendingChanges`), and the sibling rebase gathers own writes (`rebaseLayerOntoHead`), from every layer between the pending layer and the fork point or the head. Those per-statement layers are needed until commit.
- An open savepoint's snapshot must stay restorable (`savepointStack`).
- `chainContains(pending, head)` decides commit Case A versus the rebase case.
- In-transaction DDL rebuilds every open layer oldest-first (`openTransactionLayersOldestFirst`) and validates restorable states.
- `isLayerInUse` and `promoteCommittedHead` reason about who still reads an ancestor.

## Expected

Retained memory is bounded by the rows the table holds plus the layers some live view still needs: the open transactions' own layers and open savepoints. It does not grow with the number of statements committed. A committed layer that is below the current head, and that no connection's read or pending chain reaches, should become unreachable.

## Repro

Run a prepared single-row `update` in autocommit 40,000 times against one memory table, forcing GC and sampling `process.memoryUsage().heapUsed` every 10,000 statements. Count the chain with `for (l = manager.currentCommittedLayer; l; l = l.getParent())`. Retained heap grows linearly with the statement count, as in the table above.
