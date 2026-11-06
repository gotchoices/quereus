---
description: Many separate statements inside one transaction, one large "insert or fail" statement, or simply many autocommit statements crashed an in-memory table with a stack overflow, slowing down quadratically until then, because each statement added a link to a chain the tree library walks recursively. Fixed by detaching each layer's trees from that chain when the layer is frozen.
architecture: docs/memory-table.md#layer-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # freeze(), detachRebuiltTrees(), clearBase doc; adoptSchema + installNetOwnWrites call the detach
  - packages/quereus/src/vtab/memory/layer/connection.ts       # createSavepoint eager path: markCommitted() → freeze()
  - packages/quereus/src/vtab/memory/layer/manager.ts          # commitTransaction Case A / Case C fallback + rebaseLayerOntoHead: markCommitted() → freeze(); promoteCommittedHead doc
  - packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts  # new regression spec
  - docs/memory-table.md                                       # Layer Management "Freezing detaches"; Memory Management retention; Performance caveat
  - node_modules/inheritree/dist/b-tree.js                     # chainVersion() recursion, clearBase(), owner-based copy-on-write (read only)
repro: verified
---

# Frozen layers detach their B-trees so the inheritree base chain stays one link deep

## What was wrong

Every memory-table `TransactionLayer` builds its B-trees (primary and one per secondary index) over its parent layer's trees, using inheritree's copy-on-write `base`. inheritree 1.0.1's `BTree.chainVersion()` recurses once per base link, and `checkBase()` calls it on every `root` access, so each tree access costs O(chain depth). Three paths grew that chain by one link per statement, and nothing ever shortened it:

- **Eager savepoint snapshot** (`MemoryTableConnection.createSavepoint`): every DML statement inside an explicit transaction opens a statement savepoint, and `insert or fail` opens one per row (autocommit too). The pending layer was `markCommitted()` and the next pending layer was built over it.
- **Commit** (`MemoryTableManager.commitTransaction`): every autocommit statement's layer became the new committed head, and the next statement's layer was built over it. Layer collapse (`promoteCommittedHead`) only runs on `disconnect`, so a prepared statement in a loop never collapsed. **This arm was not in the original ticket.** I found it while measuring: 15,584 plain autocommit single-row inserts on one table overflowed the stack at HEAD (chain depth 15,584).
- **In-transaction DDL rebuilds** (the ticket's "second arm"): `adoptSchema`, `rekeyPrimaryKey`, `installRekeyedPrimaryKeyColumns`, `convertColumn` and `installReshapedColumns` rebuild every open layer's trees, oldest-first, over the parent's new trees. That relinks the whole chain.

## The fix

- `TransactionLayer.freeze()`: `markCommitted()`, then `clearBase()`. It warns and skips the detach if the layer already has a derived child, which is unreachable by construction. It is called at all four places a pending layer stops taking writes: the eager savepoint, commit Case A, the commit Case C fallback, and the sibling-rebase result.
  - Legal because the layer was the connection's pending head, so no tree derives from it yet. Only three `new TransactionLayer(` sites exist in `src/`, and none builds over a pending layer.
  - The code comment records the lost `MutatedBaseError` guard, plus a `NOTE:` that the depth must stay bounded because inheritree recurses per link.
- `TransactionLayer.detachRebuiltTrees(trees)`: a private helper, a no-op unless the layer is committed. It is called at the end of `installNetOwnWrites`, which is the shared tail of the four whole-layer rebuilds and covers all of their trees, and in `adoptSchema`, for only the indexes it added or replaced.
  - **Deviation from the ticket:** the ticket suggested a helper in the manager's oldest-first passes. I put it in the layer instead, because only the layer knows which trees a rebuild actually built (`adoptSchema` keeps unchanged indexes, and those may have live derived trees).
  - The safety argument does not depend on rebuild order: trees created inside the call have no derived trees when it returns.
  - The pending (uncommitted) layer is never detached. inheritree's copy-on-write only fires while `base` is set (`b-tree.js` ~1047), so a detached tree that is still written would write into the nodes it shares with its parent.

The layer-level `getParent()` chain is unchanged. Commit, rebase, `isLayerInUse`, `collectPendingChanges` and the DDL passes still walk it, all as loops run once per commit or DDL.

## Validation

- **New spec** `packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts`, about 4s total:
  - *30,000 single-row inserts in `begin`…`commit`, with a secondary index.* `savepoint sp` is taken at 20,000; `rollback to sp` restores 20,000 rows; then an in-transaction `alter table … add column` and `create index` on `(v, w)`; then commit. It asserts count, `sum(id)`, `sum(w)`, an index lookup, and that a rolled-back row is gone. This covers the savepoint arm, rollback to a detached snapshot, and both rebuild detach sites.
  - *20,000 autocommit single-row inserts.* Covers the commit arm.
  - *`insert or fail into big select … from generate_series(1, 30000)` in autocommit.* Covers the per-row savepoint arm.
- **Confirmed the tests are real:**
  - The `insert or fail` case overflowed the stack (in `chainVersion`) before the fix.
  - Disabling the `installNetOwnWrites` detach alone made the `add column` overflow.
  - Disabling the `adoptSchema` detach alone made the `create index` overflow.
  - The autocommit arm was confirmed with a depth probe at HEAD. I did not run that exact `it` before the commit change.
- **Measured after the fix:** 40,000 autocommit updates keep the tree depth at 1 and take 1.9s, which is linear.
- **Suites:**
  - `yarn workspace @quereus/quereus test`: 11,100 passing, 0 failing.
  - Every other workspace's `test`: all passing.
  - `yarn workspace @quereus/quereus lint`: exit 0.
  - `yarn test:store` was not run. Store-backed tables do not use inheritree layers, and nothing store-side changed.

## For the reviewer: known gaps and judgement calls

- **The commit-path change touches every memory-table commit,** not just transactions. It is the same primitive with the same safety argument, but it is the broadest part of the diff.
- **`promoteCommittedHead` / `tryCollapseLayers` are now effectively dead.** Every head commit installs is already detached; `freeze` skips the detach only when the layer has a derived child, and promotion refuses those too. I left them in place with an updated doc comment rather than widen the diff (they have a dedicated guard test in `layer-derived-child-guard.spec.ts`). Deleting them, the `disconnect` hook and that test is a reasonable review-time call.
- **A detached frozen layer has no `MutatedBaseError` protection.** Correctness now rests on the standing rule that committed layers, snapshots and the base layer are never written in place. I checked every in-place write site in `vtab/memory` (`base.ts`, `manager.ts`, `index.ts`): all of them write into freshly built trees.
- **The ticket's suggested `NOTE:` tripwire about layers piling up was upgraded to a backlog bug,** because measurement showed it is not conditional: every committed layer stays reachable through `parentLayer` for the table's lifetime, about 1.4 KB per statement, also in autocommit. Filed as `tickets/backlog/bug-memory-table-retains-every-committed-layer.md`. The doc's Memory Management section no longer claims unused layers are garbage collected.
- **Second finding, also filed:** `tickets/backlog/bug-memory-index-copies-every-key-for-a-repeated-value.md`. A layer's first write under an inherited secondary-index value copies that value's whole primary-key `Map`, so N statements writing one shared indexed value cost O(N²) time and retained memory: 8,000 rows gives 1.24 GB. An in-transaction `create index` on a constant-valued column after 20,000 statements exhausted a 4 GB heap, which is why the spec indexes `(v, w)` rather than `w`. I also added a cross-reference to `debt-memory-reverse-secondary-pk-order`, and a caveat to the doc's Performance section.
- **inheritree's recursive `chainVersion()`** is untouched; it is an outside dependency.
- **Timing:** the spec's largest case takes about 2.1s against the repo-wide 10s Mocha timeout. If it ever flakes under load, raise that describe's timeout rather than shrink the sizes below about 16,000, the overflow threshold.
