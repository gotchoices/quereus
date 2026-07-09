description: When two connections commit disjoint changes to the same in-memory table within one transaction, the second commit silently discards the first connection's already-committed rows. Fix the commit path so both connections' changes survive.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/transaction.ts, packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts
difficulty: medium
----

## Summary

`MemoryTableManager.commitTransaction` (`manager.ts` ~lines 452-482) has a "sibling
layer" branch that overwrites the table's committed head with the committing
connection's pending layer **wholesale**, discarding any changes another
connection committed to the same table since the pending layer was forked. This
is a silent last-writer-wins data loss.

A reproducing test already exists and **currently fails**:
`packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts`. It builds two
connections to one memory table, each writing a disjoint row into its own pending
layer forked off the same committed base `B`, then commits them sequentially. The
committed table ends up `[1, 200]` — conn1's row `100` is gone. Post-fix it must
be `[1, 100, 200]`.

## Why this happens

Layers form a copy-on-write chain (`BaseLayer` ← `TransactionLayer` ← …), each
`TransactionLayer`'s BTrees deriving (via `inheritree`) from its parent's trees.

Scenario:

```
  head = B                       (committed base)
  conn1 forks P1 (parent B)      writes id=100
  conn2 forks P2 (parent B)      writes id=200
  conn1.commit  →  head = P1     chain: B ← P1
  conn2.commit  →  sibling branch fires
```

In `conn2.commit`, the first ancestor walk (`pendingLayer.getParent()` upward,
~lines 442-450) does NOT find the head: P2's parent is `B`, and `B`'s chain does
not reach `P1`. The **second** block (~lines 452-464) then walks from the current
head `P1` upward looking for P2's parent `B`; it finds it (`P1.getParent() === B`),
sets `foundCommittedLayer = true`, and falls through to:

```ts
this._currentCommittedLayer = pendingLayer;   // head = P2, chain B ← P2
```

`P1` (and its row 100) is spliced out of the committed chain entirely.

Note two subtleties confirmed while investigating:

- The `if (!this.db._inCoordinatedCommit())` BUSY guard is **not consulted** in the
  sibling case — `foundCommittedLayer` is already `true`, so control skips the
  guard and reaches the unconditional head overwrite. The bug reproduces
  regardless of the coordinated-commit flag (the test drives it with plain
  sequential `commitTransaction` calls).
- The head-advanced-past-pending's-base condition is exactly "P2's parent is a
  *proper ancestor* of the current head, and the head is not an ancestor of P2".
  That is the branch to fix.

## Resolution: rebase, not BUSY

**Chosen resolution: rebase the pending layer onto the advanced committed head**
(replay its own writes on top of the new head), NOT reject-with-BUSY.

Rationale (this is the "which resolution matches the isolation model" question the
fix ticket asked to settle):

- A `MemoryTableManager` is owned by one `MemoryTableModule`, which is registered
  on **one** `Database` (`manager.db`). All sibling connections in a coordinated
  commit therefore belong to the **same** `Database`'s single atomic
  transaction (`database-transaction.ts` `commitTransaction` iterates
  `getAllConnections()` sequentially under `inCoordinatedCommit`).
- Throwing `StatusCode.BUSY` from inside that loop makes the outer
  `commitTransaction` catch-all roll back **every** connection and fail the user's
  `COMMIT`. Because the sibling connections arise deterministically from the same
  statements, a retry re-hits the identical path → permanent failure, not
  eventual success. BUSY-retry only makes sense for genuinely-independent
  optimistic-concurrency conflicts.
- BUSY IS already correct for the **non-coordinated** stale-commit path (the
  existing `if (!this.db._inCoordinatedCommit()) { … throw BUSY }` block) — leave
  that untouched. That path is a connection committing against a head that moved
  under it *outside* a coordinated commit, where the caller can legitimately retry.

So: preserve the existing non-coordinated BUSY behavior; add a rebase for the
sibling / head-advanced case.

## Rebase mechanics

`inheritree`'s `BTree` has **no base-swap / rebase primitive** (only `clearBase`,
`flatten`, `buildFrom` — see `node_modules/inheritree/dist/b-tree.d.ts`). A pending
layer's BTrees were constructed with `base = <old parent's tree>` and cannot be
re-pointed at the new head's tree. Rebasing therefore means **replaying the pending
layer's own writes** onto a fresh `TransactionLayer` parented on the current head.

Two pieces are needed:

### 1. An always-on own-write-set on `TransactionLayer` (`transaction.ts`)

Today `TransactionLayer.pendingChanges` records ops only when change-tracking is
enabled (data listeners present) — not reliable as a replay source. Add a compact,
**always-maintained** write-log capturing this layer's own modifications
(independent of event tracking), populated from the existing `recordUpsert` /
`recordDelete` entry points which already receive `primaryKey`, `newRowData`, and
`oldRow`:

- Keep it minimal: an ordered list of `{ type: 'upsert' | 'delete', primaryKey,
  newRow?, oldRow? }`, or a pk-keyed last-write map if ordering within a single
  layer is not required for correctness (upserts/deletes to the same pk collapse —
  the last one wins, matching the layer's own effective state). An ordered list is
  the safe default; document the choice.
- Expose `getOwnWrites(): readonly OwnWrite[]`.
- This is a small always-on allocation per layer. `// NOTE:` it at the field: if
  write-heavy transactions ever show memory pressure from this log, collapse it to
  a pk-keyed map (last-write-wins per pk) since only the net effect is replayed.

### 2. A rebase routine in `commitTransaction` (`manager.ts`)

When the sibling / head-advanced case is detected (head is a proper descendant of
the pending layer's parent, i.e. the current second block), instead of
`this._currentCommittedLayer = pendingLayer`:

- Gather the own-writes of `pendingLayer` **and** any in-transaction ancestor
  `TransactionLayer`s up to (but not including) the pending layer's original
  parent — mirror the existing `eventChunks` chain walk (~lines 421-434), in
  chronological order.
- Create `const rebased = new TransactionLayer(this._currentCommittedLayer)`
  (enable change tracking if `this.eventEmitter?.hasDataListeners?.()`, matching
  `ensureTransactionLayer`).
- Replay each own-write via `rebased.recordUpsert(...)` / `rebased.recordDelete(...)`
  in order. This rebuilds primary + secondary index BTrees on top of the new head
  automatically.
- `rebased.markCommitted(); this._currentCommittedLayer = rebased;
  connection.readLayer = rebased;` then clear pending/savepoints as today.
- Keep emitting the already-collected `changes` (the pre-rebase event chunks are
  the same logical row changes; event emission is unaffected).

### Conflict + schema edge cases (specify + document, do not over-engineer)

- **Same-PK concurrent write** (both siblings wrote the same primary key): replay
  via `recordUpsert` overwrites at that key — a *defined* last-writer-wins on the
  single contended key, while every non-contended key from both layers survives.
  This satisfies the ticket's guarantee ("must never drop another connection's
  committed changes") for all disjoint keys; only a genuinely double-written key
  resolves to the rebasing writer. Full write-write conflict **detection** is out
  of scope — the memory manager is read-your-own-writes, not snapshot isolation
  (that lives in `quereus-isolation`). Record this as a `// NOTE:` at the replay
  site, and as a one-line entry in the review findings.
- **Secondary-UNIQUE collision across siblings**: `recordUpsert` is the raw
  structural write and does not re-run `checkUniqueConstraints`; a UNIQUE conflict
  that only exists *between* the two siblings' rows will not be detected at rebase.
  Same isolation-model rationale as above — document as a `// NOTE:`, do not add
  constraint re-checking here.
- **Schema drift** (an `ALTER TABLE` consolidated the head to a different schema
  between the two layers): if `pendingLayer.getSchema() !== this._currentCommittedLayer.getSchema()`
  (equivalently `!== this.tableSchema`), replay is unsafe — fall back to the
  existing BUSY error rather than replaying stale-schema rows onto a new-schema
  head. This mirrors the existing "stale ancestor / out-of-date schema" caution at
  the top of `commitTransaction` (~lines 384-403).

## TODO

- [ ] Add an always-on own-write-set to `TransactionLayer` (`transaction.ts`):
      populate from `recordUpsert`/`recordDelete`, expose `getOwnWrites()`. `// NOTE:`
      the memory-pressure fallback (collapse to pk-keyed last-write map).
- [ ] In `manager.ts` `commitTransaction`, replace the unconditional
      `this._currentCommittedLayer = pendingLayer` in the sibling/head-advanced case
      with the rebase routine: walk own-writes of pending + in-txn ancestors,
      build a fresh `TransactionLayer` on the current head, replay, mark committed,
      set head + `connection.readLayer`.
- [ ] Add the schema-drift guard (fall back to BUSY when the advanced head carries
      a different schema).
- [ ] Leave the existing non-coordinated `!_inCoordinatedCommit()` BUSY block
      intact — that path is correct as-is.
- [ ] `// NOTE:` the same-PK / secondary-UNIQUE cross-sibling last-writer-wins
      behavior at the replay site.
- [ ] Verify `test/vtab/coordinated-commit-sibling.spec.ts` now passes; extend it
      with (a) an UPDATE/DELETE sibling (not just INSERT), and (b) a three-way
      chain (B ← P1 ← rebased-P2, then a third sibling P3 rebased onto that) to
      confirm repeated rebasing preserves all non-conflicting rows.
- [ ] Run `yarn test` (memory-backed) — watch for regressions in the existing
      transaction/savepoint/collapse suites, which exercise the same commit path.
- [ ] `yarn lint` (real lint only in `packages/quereus`).
- [ ] Update `docs/runtime.md` (or the memory-vtab layer section) to describe the
      rebase-on-sibling-commit behavior and the isolation-model boundary (why
      rebase in coordinated commits, BUSY otherwise).
