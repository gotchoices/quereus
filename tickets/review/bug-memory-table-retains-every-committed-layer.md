description: An in-memory table kept a small record of every write statement it had ever run, so its memory grew with the number of statements rather than the number of rows. Each newly committed version now drops its link to the versions before it; review that the change keeps commits, sibling-connection merges and in-transaction schema changes correct.
architecture: docs/memory-table.md#memory-management
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # parentLayer now private+mutable; treesDetached (set by freeze); publishAsHead; getPublishedGeneration; clearPendingChanges removed
  - packages/quereus/src/vtab/memory/layer/manager.ts       # historyGeneration; commitTransaction (Case A/B/C rewritten); forkedFrom; isInCurrentHistory; installReplacementBase; rebaseLayerOntoHead (no change tracking); collapse code deleted; consolidateToBaseLayer; renameTable NOTE
  - packages/quereus/src/vtab/memory/layer/interface.ts     # getParent / noteDerivedChild / hasDerivedChildren docs
  - packages/quereus/src/vtab/memory/table.ts               # sync/disconnect comments
  - packages/quereus/src/vtab/memory/module.ts              # readCommitted audit point 4 rewritten
  - packages/quereus/src/vtab/memory/index.ts               # clearBase doc
  - packages/quereus-isolation/src/isolated-table.ts        # disconnect doc (comment only)
  - packages/quereus-isolation/src/isolation-module.ts      # connectCommitted doc (comment only)
  - packages/quereus/test/vtab/layer-tree-chain-depth.spec.ts
  - packages/quereus/test/vtab/layer-derived-child-guard.spec.ts
  - packages/quereus/test/vtab/layer-collapse-mutated-base.spec.ts
  - packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts
  - docs/memory-table.md
  - tickets/backlog/bug-memory-index-copies-every-key-for-a-repeated-value.md
----
# Committed layers are released

## What was wrong

A memory table's data lives in layers: a base layer plus one `TransactionLayer` per committed write statement, each pointing at the layer it was built over (`parentLayer`, readonly). The committed head therefore kept every earlier head, and every statement-savepoint snapshot below them, reachable for the table's lifetime. Measured before the fix: 40,000 autocommit updates of a one-row table left a 40,002-layer chain and grew the heap about 1.4 KB per statement.

## What changed

**Re-parent on publish.** `TransactionLayer.publishAsHead(base, generation)` runs at the end of `commitTransaction`, after the commit has collected events from the old chain. It points the new head's parent at the table's base layer and stamps it with the manager's current history generation. Safe because `freeze` has already detached the head's B-trees from their base (since `bug-many-inserts-in-one-transaction-overflow-stack`), so the parent link is no longer a read path. If `freeze` could not detach (its derived-child guard fired), `treesDetached` is false and `publishAsHead` warns and keeps the real parent. Applied on all three publish paths (Case A wholesale, Case B rebased layer, Case C coordinated-commit fallback).

**Why the base and not null:** the in-transaction DDL rebuilds replay a layer's own writes over its parent's trees, and `chainContains(pending, base)` must still find the base after consolidation. Every tree-rebuilding DDL arm calls `ensureSchemaChangeSafety` first, which drains the head into the base, so the base then holds exactly the head's view. Audited: every caller of `adoptSchemaOnOpenLayers` / `convertColumnOnOpenLayers` / `prepareReshapeOnOpenLayers` / `validateRekeyedPrimaryKey` runs after `ensureSchemaChangeSafety` except `renameTable`, whose `adoptSchema` keeps every `IndexSchema` object and so rebuilds nothing. A `NOTE:` at `renameTable` records that this is what keeps it sound.

**Fork point by history generation.** The old Case B search intersected the head's parent chain with the pending chain. After the cut the head chain is just head → base, so that search would land on the base and replay already-committed writes. Now:
- `forkedFrom(pending)`: the first layer below the pending layer that is a base layer or a published head (`getPublishedGeneration() !== undefined`). Savepoint snapshots are `markCommitted()` too, so "committed" is not the test.
- Case A: `chainContains(pending, head)` (unchanged test).
- Case B: fork point is the current base or a head with the current generation → rebase (schema-drift BUSY check unchanged).
- Case C: otherwise → BUSY outside a coordinated commit; wholesale publish inside one, which bumps the generation.
- `historyGeneration` is also bumped by `installReplacementBase` (used by `replaceBaseLayer` and `destroy`). Consolidation does not bump.
- Events: every case now collects pending-change events from the pending layer down to the fork point. This replaces `TransactionLayer.clearPendingChanges` (deleted), which consolidation used to stop re-delivery of drained heads' events. Behaviour for Case C changed slightly: it used to collect all the way to the chain root (re-delivering older heads' events); it now delivers only the transaction's own.
- The rebased layer in Case B no longer enables change tracking: its log was never read (the commit delivers events from the pending chain, and later collections stop at the rebased head).

**Collapse code deleted.** `tryCollapseLayers`, `promoteCommittedHead`, `isLayerInUse`, `layerChainSet`, the background collapse call in `disconnect`, the commented-out call in `MemoryTable.sync`, and the collapse references in comments (interface.ts, table.ts, module.ts, index.ts, isolation package). The derived-child counter stays: `freeze` still uses it.

## Measured after the fix

Temporary spec (deleted), node 24.2.0, `--expose-gc`, one-row table, prepared `update t set g = ? where id = 1` in autocommit:

| statements | chain length | heapUsed |
|---|---|---|
| 10,000 | 2 | 95.1 MB |
| 20,000 | 2 | 94.9 MB |
| 30,000 | 2 | 95.1 MB |
| 40,000 | 2 | 94.9 MB |

Also re-measured the backlog ticket `bug-memory-index-copies-every-key-for-a-repeated-value` (index on a one-value column, N = 4,000 inserts): autocommit now retains about 3 MB (was 319 MB); inside one transaction the open chain still holds about 320 MB until commit and releases it at commit. That ticket's description and body were corrected to say its memory cost now applies only inside a transaction; its time cost is unchanged.

## Tests

- `layer-tree-chain-depth.spec.ts` › "releases the layers below each committed head" (new): after 30 autocommit inserts, and after a 30-statement `begin`/`commit`, the committed head's `getParent()` chain is exactly 2 (head, base), plus a row-count/sum check. Confirmed it fails with the re-parent line disabled.
- `layer-derived-child-guard.spec.ts`: deleted the `promoteCommittedHead` refusal case and its internals type entry; kept the derived-child marking, `MutatedBaseError`-on-clearBase, and eager-savepoint `disconnect` deferral cases (all still live behaviour). Renamed the describe.
- `layer-collapse-mutated-base.spec.ts`: kept (cascade-delete savepoint shapes still drive `freeze`'s detach and now `publishAsHead`); header comment updated.
- `coordinated-commit-sibling.spec.ts`: unchanged; its four cases are the guard on the fork-point rule and pass.

Ran: `yarn workspace @quereus/quereus lint` (clean), `yarn workspace @quereus/quereus build` (clean), `yarn test` (all workspaces pass; quereus 11,135 passing / 26 pending / 0 failing). `yarn test:store` not run (store module does not use these layers).

## Things for the reviewer to look at

- **Case A after consolidation for a sibling forked from an older head.** After consolidation the head is the base, so `chainContains(pending, base)` is true for every pending layer and any sibling publishes wholesale, even one that forked from a head older than the one drained (it would drop that newer head's rows). This was true before the fix as well (the base was at the bottom of every chain) and needs a DDL during a coordinated multi-connection commit to reach, which `ensureSchemaChangeSafety`'s BUSY check makes unlikely. Not changed, not ticketed; worth a second opinion on whether it is reachable.
- **Case C second stale pending** (tripwire, `NOTE:` at the Case C fallback in `commitTransaction`): a second stale pending forked from the same retired fork point now gets replaced wholesale instead of rebased onto the first fallback head. Unreachable today, since a base replacement refuses while another connection has open work.
- **Docs claim** in `docs/memory-table.md` that a sibling forked from a head later drained by a schema change, committing after a newer head, now rebases only its own writes. This follows from the rule (consolidation does not bump the generation) but has no dedicated test.
- `publishAsHead`'s refusal branch (trees not detached) is not exercised by any test; it needs `freeze`'s derived-child guard to fire, which the docs say cannot happen for a pending layer.
- `forkedFrom` returns `Layer | null`; null is unreachable (every chain ends at a `BaseLayer`), and the commit treats null as Case C.
