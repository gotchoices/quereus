---
description: Many separate statements inside one transaction, or one large "insert or fail" statement, crash an in-memory table with a stack overflow and slow down quadratically until then, because each savepoint adds a link to a chain the tree library walks recursively.
architecture: docs/memory-table.md#layer-management
files:
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/index.ts
  - docs/memory-table.md
  - node_modules/inheritree/dist/b-tree.js
repro: verified
----

# Savepoint snapshots grow the B-tree base chain by one per statement

## Symptom (reproduced)

Run under `node --import ./packages/quereus/register.mjs` against the current source, node v24.2.0, default stack:

- Explicit transaction plus a prepared single-row `insert into big values (?, ?)` repeated 50,000 times fails at row 15,598 with `Execution error: Maximum call stack size exceeded`.
- `insert or fail into big select id, 'x' from src` with 30,000 source rows fails the same way. It fails in autocommit as well as inside `begin`. This second case was not in the original report.
- Before the crash, cost grows quadratically. With the recursion replaced by a loop, which removes the crash only, 5,000 / 10,000 / 15,000 / 20,000 statements took 0.8 / 4.1 / 10.1 / 18.9 seconds. A plain `select count(*)` after the commit then took another 13 seconds.

## Root cause

`MemoryTableConnection.createSavepoint` (`vtab/memory/layer/connection.ts`) takes an "eager" snapshot whenever a pending layer exists. It calls `markCommitted()` on the pending layer, installs that layer as `readLayer`, and clears `pendingTransactionLayer`. The next write runs `ensureTransactionLayer`, which builds a new `TransactionLayer` whose B-trees use the snapshot's trees as their inheritree `base`.

Two kinds of savepoint reach this path:

- Every DML statement inside an explicit transaction opens a statement savepoint (`runWithStatementSavepoints` in `runtime/emit/dml-executor.ts`).
- `OR FAIL` opens a savepoint per row, in autocommit too, once the first row has created a pending layer.

`RELEASE` only pops the stack entry. Nothing ever shortens the chain, so after N statements (or N `OR FAIL` rows) the pending layer's primary tree has a base chain N deep. Every secondary index tree has one too.

inheritree 1.0.1 `BTree.chainVersion()` is `this._version + (this.base ? this.base.chainVersion() : 0)`, which recurses once per link. `checkBase()` calls it on every `root` access, so each read or write costs O(chain depth). That is the quadratic slowdown, and the recursion is the stack overflow.

## Fix (validated by monkey-patch)

A snapshot is immutable from the moment it is frozen. At that moment it has no derived children, because it was the pending head. So its trees can be detached from their base with `TransactionLayer.clearBase()` right then. A detached tree keeps the full merged view in its own root, which is O(1) to set up, and shares nodes with the former base. That is safe because neither side is ever mutated in place again. This is the same reasoning the existing `promoteCommittedHead` collapse relies on, and its safety condition holds by construction here: the layer has no derived children.

The experiment patched `MemoryTableConnection.prototype.createSavepoint`: after the original call, if the old pending layer `isCommitted() && !hasDerivedChildren()`, it called `clearBase()`. Results:

- The 50,000-statement explicit transaction, with a secondary index plus a trailing `update` and `delete`, completed in 3.2s with a tree chain depth of 1. Count, `sum(id)`, and index lookups were all correct.
- `insert or fail … select` of 30,000 rows took 0.57s in autocommit and 0.62s inside `begin`. Both were correct.

The layer-level parent chain (`getParent()`) is left intact. Commit's `chainContains`, `collectPendingChanges`, the Case B rebase fork-point search, `isLayerInUse`, and `openTransactionLayersOldestFirst` all still walk it. All of those walks are loops and run once per commit or per DDL, not once per row. Nothing in `src/` reads B-tree node ownership or `base` to work out a layer's own delta: the per-layer `ownWrites` log and change tracking are separate. A grep for `.owner`, `.base`, `chainVersion`, and `clearBase` under `packages/quereus/src` confirmed this.

What detaching gives up: inheritree's `MutatedBaseError` guard no longer catches an in-place mutation of an ancestor tree (the committed head, the base layer, or an older snapshot) under a detached snapshot. The codebase already depends on those trees never being mutated in place. Base rebuilds and in-transaction ALTER rebuilds replace the tree object, as `prepareReshapeOnOpenLayers` documents, and promotion already detaches committed heads. Say this in a code comment at the detach site.

## Second arm: in-transaction ALTER rebuilds re-deepen the chain

The oldest-first whole-layer rebuilds rebuild each open layer's trees over its parent's current tree. These are `newPrimaryTreeOverParent` / `installNetOwnWrites`, `adoptSchema` (new `MemoryIndex` over `parentSecondaryTree`), `rekeyPrimaryKey`, `convertColumn`, and `installReshapedColumns`, all in `transaction.ts`. Each new tree's construction calls `parent.chainVersion()`. After N statements followed by an ALTER in the same transaction, the rebuild therefore relinks an N-deep chain: the stack overflows during the ALTER itself once N is past about 15,000, and later statements pay O(N) per access again.

The rebuild runs oldest-first. When a committed snapshot layer k has just been rebuilt, its new trees have no derived children yet, because layer k+1 is rebuilt only afterwards. So it can be detached right after its own rebuild. Note that `hasDerivedChildren()` is per layer and never decrements, so it reports true here. Base the decision on the rebuild order, not on that flag, and do not detach the pending (uncommitted) layer.

This arm is static analysis only: no ALTER-after-15k-statements run was made. Confirm it with a run before relying on the analysis, or cover it with the regression test below at a size above the overflow threshold.

## Not done here

- **inheritree's recursive `chainVersion()`** is an outside dependency (github.com/Digithought/Inheritree). Making it a loop would turn the crash into a slowdown but would not remove the O(depth) per access. With the fix above the chain stays shallow, so do not wait on it. Leave a `NOTE:` at the detach site saying depth is bounded here because inheritree recurses per link.
- **The layer objects still pile up** within a transaction, one `TransactionLayer` per statement, each with its `ownWrites` array. That is O(statements) memory until commit or collapse, which is no worse than the rows themselves. Record it as a `NOTE:` tripwire, not a ticket: if per-statement layer overhead ever shows up in memory profiles, release popped snapshots' layer records.
- **Store-backed tables** (`quereus-store` / LevelDB) do not use inheritree layers and were not tried.

## TODO

- Add a `TransactionLayer` method (e.g. `freezeAsSnapshot()`, or extend `markCommitted` at this call site) that marks the layer committed and detaches its primary and secondary trees when it has no derived children. Call it from the eager branch of `MemoryTableConnection.createSavepoint` in place of the bare `markCommitted()`. Comment why it is safe and what guard is lost (see above).
- Second arm: in the oldest-first rebuild passes in `manager.ts` (`adoptSchemaOnOpenLayers`, `convertColumnOnOpenLayers`, `installReshapeOnOpenLayers`, and the rekey path), detach each committed, non-pending layer's freshly rebuilt trees before its child is rebuilt. Prefer a single helper used by every pass over per-call-site copies.
- Update `TransactionLayer.clearBase`'s doc comment (it says `tryCollapseLayers` is the only caller), plus `docs/memory-table.md` § Layer Management, to describe snapshot detachment and why it is legal: a frozen snapshot has no derived children at freeze time, and committed and snapshot trees are never mutated in place.
- Add one regression spec under `packages/quereus/test/` (memory vtab), well above the roughly 15.6k overflow threshold: about 30,000 single-row prepared inserts inside `begin` … `commit`, plus `insert or fail … select` of about 30,000 rows. Assert the counts. Optionally, in the explicit-transaction case, add a `rollback to savepoint` taken partway through and check the row count it restores, so detached snapshots are shown to still restore correctly. With the fix each arm runs in under about 2s; keep the spec lean. If the second arm is implemented, extend the same spec with an `alter table … add column` after the inserts, inside the same transaction.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. Savepoint, ALTER-in-transaction, and commit-rebase specs are the likeliest to notice a mistake. Consider `yarn test:store` only if something store-related changes.
