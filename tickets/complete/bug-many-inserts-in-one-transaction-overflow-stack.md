---
description: Many separate statements inside one transaction, one large "insert or fail" statement, or simply many autocommit statements crashed an in-memory table with a stack overflow, slowing down quadratically until then, because each statement added a link to a chain the tree library walks recursively. Fixed by detaching each layer's trees from that chain when the layer is frozen.
architecture: docs/memory-table.md#layer-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # freeze(), detachRebuiltTrees(), clearBase doc; adoptSchema + installNetOwnWrites call the detach
  - packages/quereus/src/vtab/memory/layer/connection.ts       # createSavepoint eager path: markCommitted() → freeze()
  - packages/quereus/src/vtab/memory/layer/manager.ts          # commitTransaction Case A / Case C fallback + rebaseLayerOntoHead: markCommitted() → freeze(); promoteCommittedHead doc
  - packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts  # regression spec (asserts tree chain depth directly)
  - docs/memory-table.md                                       # Layer Management "Freezing detaches"; Memory Management retention; Performance caveat
repro: verified
---

# Frozen layers detach their B-trees so the inheritree base chain stays one link deep

## What was wrong

Every memory-table `TransactionLayer` builds its B-trees (primary and one per secondary index) over its parent layer's trees, using inheritree's copy-on-write `base`. inheritree 1.0.1's `BTree.chainVersion()` recurses once per base link and runs on every tree access. Three paths grew that chain by one link per statement:

- the eager savepoint snapshot in `MemoryTableConnection.createSavepoint`, taken once per DML statement inside a transaction and once per row under `insert or fail`;
- `MemoryTableManager.commitTransaction`, which builds each autocommit statement's layer over the previous head;
- in-transaction DDL rebuilds (`adoptSchema`, `rekeyPrimaryKey`, `installRekeyedPrimaryKeyColumns`, `convertColumn`, `installReshapedColumns`), which rebuild every open layer's trees over the parent's new trees.

Past about 15,600 links the walk overflowed the stack.

## The fix

The implementation is in `` `ticket(implement): bug-many-inserts-in-one-transaction-overflow-stack` ``.

- `TransactionLayer.freeze()` marks the layer committed and calls `clearBase()` on its trees. It is called wherever a pending layer stops taking writes: the eager savepoint, commit Case A, the Case C fallback, and the rebased layer from a sibling rebase. This is legal because a pending layer has no derived trees.
- The private `TransactionLayer.detachRebuiltTrees` detaches the trees a DDL rebuild just built for a frozen layer. It is called at the end of `installNetOwnWrites` (the shared tail of the four whole-layer rebuilds) and in `adoptSchema` for the indexes it added or replaced. It never detaches the pending layer, which still needs copy-on-write.
- The layer-level `getParent()` chain is unchanged.

## Review findings

**Read the implement diff first**, then the handoff. Verified the safety argument against the code:

- **No in-place writes into a detached tree, or into a tree it shares nodes with.** Detached trees no longer copy on write, and inheritree's `MutatedBaseError` guard no longer covers them.
  - `recordUpsert` and `recordDelete` throw on a committed layer (`transaction.ts` ~928, ~995).
  - Base-layer rebuilds in `base.ts` and the drain in `manager.ts` ~1741 build new trees and then assign them. `BaseLayer` populates new `MemoryIndex` maps before installing them.
  - `MemoryIndex.addEntry` / `removeEntry` mutate entries in place only when this index instance owns them (`ownedEntries`). Detaching does not change which entries an index owns.
- **`freeze` cannot meet a layer with a derived child.** `noteDerivedChild` is only called by the `TransactionLayer` constructor on its parent, and no constructor site builds over a pending layer. So the warn-and-skip branch is a guard only. Freezing a layer twice is also not reachable: commit wraps a fresh empty layer around a savepoint snapshot instead of freezing the snapshot again.
- **Rollback to a detached snapshot works.** It restores `readLayer = snapshot` with no pending layer, and the next pending layer is built over the snapshot with copy-on-write. The spec covers this.
- **Commit-path breadth.** `clearBase` is O(1) per tree. Its `checkBase()` can now throw at commit time if a base was already mutated, but before this change that same state threw on the next access, so it is not a new failure mode.
- **Store path.** `quereus-isolation` overlays are memory tables by default, so the commit and savepoint changes run under the store too. `yarn test:store`: 11,093 passing, 0 failing. The implementer had skipped it.

**Tests: rewritten (minor, fixed inline).** The implementer's spec detected the bug only by overflowing the stack. That needed 20,000–30,000 statements per case (about 4s per run) and depended on the stack size of the machine. I replaced it with the same three scenarios at 40–60 statements. Each case asserts the invariant directly: no tree on any connection's read or pending layer, or on the committed head, sits more than one base link deep. The rollback, DDL and data assertions are unchanged. The spec now runs in about 90ms. Mutation check: disabling the `clearBase()` in `freeze` fails the transaction case (depth 60), the `insert or fail` case (depth 50) and the autocommit case (depth 40). Disabling the `installNetOwnWrites` detach fails the transaction case after `add column`. Disabling the `adoptSchema` detach fails it after `create index` (depth 40). The spec reads inheritree's `base` field, which is private in its typings, through a narrow local type, and reaches the manager's `connections` map the same way `layer-derived-child-guard.spec.ts` does.

**Dead collapse code (major, filed as an arm, not deleted here).** `tryCollapseLayers` and `promoteCommittedHead` now only re-detach heads that are already detached. Deleting them belongs with whatever replaces them for releasing committed layers, so I added a "Second arm" section to `tickets/backlog/bug-memory-table-retains-every-committed-layer.md` that lists the code, tests and doc text to remove.

**Implementer's filed tickets.** I read both and kept them as filed. `bug-memory-table-retains-every-committed-layer` and `bug-memory-index-copies-every-key-for-a-repeated-value` each give measured numbers, a root-cause site and a `tradeoffs:` line. The cross-reference added to `debt-memory-reverse-secondary-pk-order` is accurate.

**Docs.** `docs/memory-table.md` matches the code: the freezing paragraph, the promotion caveat, the corrected Memory Management bullets and the Performance caveat. No other doc mentions `clearBase`, `markCommitted` or the collapse path, which I checked with grep.

**Tripwires.** The implementer's `NOTE:` in `freeze` ("the depth must stay bounded because inheritree recurses per link") is the right place for that concern. I added no new tripwires.

**Not addressed.** inheritree's recursive `chainVersion()` is an outside dependency. With the chain bounded, it no longer matters here.

**Other categories checked, nothing found.**
- Type safety: no `any`.
- Resource cleanup: `freeze` allocates nothing.
- Error handling: the skip path logs a warning.
- Source hygiene: the comments state constraints rather than narrating the code.
- File size: `transaction.ts` grew by about 60 lines, all documented helpers.

**Validation.**
- `yarn workspace @quereus/quereus test`: 11,100 passing, 0 failing (run before the spec rewrite).
- The rewritten spec on its own: 3 passing.
- `yarn workspace @quereus/quereus lint`: exit 0 (run after the rewrite).
- `yarn test:store`: 11,093 passing.
