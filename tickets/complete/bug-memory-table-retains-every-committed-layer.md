description: An in-memory table kept a small record of every write statement it had ever run, so its memory grew with the number of statements rather than the number of rows. Each newly committed version now drops its link to the versions before it, and commits, sibling-connection merges and in-transaction schema changes stay correct.
architecture: docs/memory-table.md#memory-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # parentLayer private+mutable; treesDetached (set by freeze); publishAsHead; getPublishedGeneration; clearPendingChanges removed
  - packages/quereus/src/vtab/memory/layer/manager.ts       # historyGeneration; commitTransaction Case A/B/C; forkedFrom; isInCurrentHistory; installReplacementBase; collapse code deleted
  - packages/quereus/src/vtab/memory/layer/interface.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts
  - packages/quereus/test/vtab/layer-derived-child-guard.spec.ts
  - docs/memory-table.md
  - docs/design-isolation-layer.md
----
# Committed layers are released

## What was wrong

A memory table's data lives in layers: a base layer plus one `TransactionLayer` per committed write statement, each pointing at the layer it was built over. The committed head therefore kept every earlier head, and every statement-savepoint snapshot below them, reachable for the table's lifetime: 40,000 autocommit updates of a one-row table left a 40,002-layer chain and grew the heap about 1.4 KB per statement.

## What changed (see `ticket(implement): bug-memory-table-retains-every-committed-layer`)

- `TransactionLayer.publishAsHead(base, generation)` runs at the end of `commitTransaction`, after the commit has collected events. It points the new head's parent at the base layer (sound because `freeze` already detached the head's B-trees from their base) and stamps it with the manager's history generation. If `freeze` could not detach, the real parent is kept.
- The sibling-rebase fork point is now `forkedFrom(pending)` — the first base layer or published head below the pending layer — and a rebase is allowed when that layer is the current base or a head from the current generation. The generation is bumped by base replacement (`replaceBaseLayer`, `destroy`) and by the coordinated-commit stale fallback; consolidation does not bump it.
- Every commit case delivers events from the pending layer down to the fork point, which replaced `clearPendingChanges`.
- The dead layer-collapse machinery (`tryCollapseLayers`, `promoteCommittedHead`, `isLayerInUse`, `layerChainSet`) was deleted.

After the fix, 10,000–40,000 autocommit updates keep the head chain at 2 layers and the heap flat (~95 MB).

## Review findings

**Read first:** the implement diff, with fresh eyes, then the handoff.

**Correctness — checked, no defects found.**
- Case A (head in pending's chain): pending → savepoint snapshots → head → base, so `forkedFrom` lands on the head and the event span matches the old one. After consolidation the head is the base, `forkedFrom` lands on the drained head, and the existing test `alter-table-events.spec.ts` › "a pre-transaction committed write is not re-delivered when the ALTER consolidates it into the base" covers the event behaviour that `clearPendingChanges` used to provide. It passes.
- Case B (sibling forked from an older head of the same generation, or from the base): this has the same outcome as the old common-ancestor search. The rebased layer is new, so its `freeze` detaches and `publishAsHead` re-parents it. `coordinated-commit-sibling.spec.ts` passes.
- Case C: base replacement and stale pending layers end up in the same branch as before (the old and new chains never shared a layer then either). The events now leave out older heads' logs, which the old code re-delivered.
- `ensureTransactionLayer` builds over `readLayer`, which can be an older head of the current generation. That correctly rebases.
- Every `parentLayer` read in `transaction.ts` (the tree rebuilds at lines ~203, 276, 394, 474, 787) runs only after `ensureSchemaChangeSafety` has drained the head into the base, except `renameTable`. Its new `NOTE:` holds: `adoptSchema` keeps the `IndexSchema` objects, so nothing is rebuilt. `validateRekeyedPrimaryKey`'s chain walk and `copyTransactionDataToBase` read whole merged trees, so the shorter chain loses nothing.
- I checked when `freeze` meets a layer that already has a derived child: the pending layer, the eager savepoint wrap and rollback-to-savepoint paths never build a child over a pending layer before it is frozen. So `publishAsHead`'s refusal branch is unreachable. It is kept as a logged fallback, which is reasonable.
- Handoff item 1 (Case A after consolidation for a sibling forked from an older head): not reachable. `ensureSchemaChangeSafety` throws BUSY while any connection other than the one running the schema change has open work, and it re-points idle connections' read layers at the base. It was also the same before the fix. No ticket.
- Handoff item 2 (second stale pending in Case C): the existing `NOTE:` tripwire at the Case C fallback is accurate. Left as is.

**Docs — fixed inline.**
- `docs/design-isolation-layer.md` still described disconnect as dropping "collapse protection" and memoized handles as holding the chain "against collapse". Reworded both to describe the current behaviour: the connection, and the committed layer it pinned, stay reachable.
- `docs/memory-table.md`: the paragraph on a sibling forked from a drained head described the scenario loosely and included a historical "before the history marker" note. It now says this is the schema-change transaction's own case, since it is the only connection that can hold open work across the drain, and drops the history.
- `packages/quereus/src/vtab/memory/module.ts` `concurrencyMode` comment ("an in-place layer collapser would force this back to 'serial'"): still a valid conditional warning about future work. Left.

**Tests.** The new chain-length case in `layer-tree-chain-depth.spec.ts` reproduces the bug (the implementer confirmed it fails without the re-parent), so I kept it. Deleting the `promoteCommittedHead` case was correct, since that code is gone. No tests added: the reviewed paths are covered by the existing sibling-commit, schema-change event, and derived-child specs, and the handoff's one untested docs claim is the schema-change-plus-concurrent-commit case, which a single Database cannot produce from SQL.

**Hygiene / types / resources.** The change is a net deletion in `manager.ts`. The new methods are small and single-purpose, with no `any`. Comments state constraints rather than narrate code. `manager.ts` was already very large before this change, and the change made it smaller, so no new size-debt ticket.

**Tripwires.** No new ones. The existing Case C `NOTE:` and the `renameTable` `NOTE:` are the two conditional concerns, both already at their code sites.

**Validation.** `yarn workspace @quereus/quereus lint`: clean. `yarn workspace @quereus/quereus test`: 11,135 passing, 26 pending, 0 failing. I did not re-run the other workspaces, since this review changed only docs and the implement run passed them. I did not run `yarn test:store`, because the store module does not use these layers.
