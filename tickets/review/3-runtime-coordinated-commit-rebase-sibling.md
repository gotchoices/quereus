description: When two connections commit disjoint changes to the same in-memory table in one transaction, the second commit used to silently discard the first's already-committed rows; the commit path now rebases instead of overwriting, so both survive.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/transaction.ts, packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts, docs/memory-table.md
difficulty: medium
----

## What was wrong

`MemoryTableManager.commitTransaction` had a "sibling layer" branch that
overwrote the committed head with the committing connection's pending layer
**wholesale**. When two connections forked pending layers `P1`, `P2` off the same
committed base `B` and committed sequentially, the second commit spliced `P1` (and
every row conn1 committed) out of the chain — a silent last-writer-wins data loss.
See `tickets/complete/` history / the implement ticket for the full failure walk.

## What changed

### `transaction.ts` — always-on own-write log
- Added `OwnWrite` (`{ type: 'upsert' | 'delete', primaryKey, newRow? }`) and a
  private `ownWrites: OwnWrite[]` field, populated unconditionally from
  `recordUpsert` / `recordDelete` (independent of the event-tracking
  `pendingChanges`, which only records when listeners are present — so it is NOT a
  reliable replay source).
- Exposed `getOwnWrites()`. A `NOTE:` at the field documents the memory-pressure
  fallback (collapse to a PK-keyed last-write map).

### `manager.ts` — rebase instead of wholesale overwrite
`commitTransaction`'s locked section was restructured into three explicit cases
(see the big comment block):
- **Case A — head is an ancestor of pending:** unchanged behavior; publish
  wholesale.
- **Case B — head advanced past pending's fork point (sibling):** *rebase*. New
  helper `rebaseLayerOntoHead` builds a fresh `TransactionLayer` parented on the
  advanced head and replays the pending chain's own-writes (pending + in-txn
  ancestor layers down to, but excluding, the fork point) on top. The head becomes
  the new layer's base, so the sibling's rows are inherited automatically; only
  this branch's writes replay. Schema-drift guard: if `pendingLayer.getSchema() !==
  this.tableSchema`, abort with `BUSY` rather than replay stale-schema rows.
- **Case C — no common ancestor:** `BUSY` outside a coordinated commit (unchanged);
  inside one, the prior wholesale fallback is preserved.
- Two new helpers: `layerChainSet` (chain → Set) and `collectPendingChanges`
  (fork-bounded event gather, extracted from the old inline pre-lock walk).

### Rebase replay detail (the isolation seam)
Each own-write re-derives the **effective row at its PK on the new head**
(`lookupEffectiveRow(pk, rebased)`, seeing earlier replays too) and passes it as
the "old row" to `recordUpsert`/`recordDelete`, so secondary-index maintenance
removes the correct pre-existing entry. Consequence, documented as a `NOTE:` at the
replay site and in `docs/memory-table.md`:
- A PK **or** secondary-`UNIQUE` value written by *both* siblings resolves
  last-writer-wins to the rebasing writer; every non-contended key survives.
- `recordUpsert` is the raw structural write and does **not** re-run
  `checkUniqueConstraints`, so a `UNIQUE` collision existing only *between* the two
  siblings' rows is not detected here. This matches the memory manager's
  read-your-own-writes model; full conflict detection lives in `quereus-isolation`.

## How to validate

- **Primary:** `packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts` —
  now 3 cases, all pass:
  - disjoint INSERT siblings → `[1, 100, 200]` (the original repro);
  - a sibling whose writes are UPDATE + DELETE (not just INSERT) → asserts both
    conn1's DELETE/UPDATE and conn2's UPDATE/INSERT survive with correct values;
  - a three-way chain `B ← P1 ← rebased-P2 ← rebased-P3` → all four rows survive.
  Run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts"`
  (from repo root).
- **Full suite:** `yarn test` — green (quereus package 6527 passing; ~4m wall
  clock across all workspaces, zero failures).
- **Lint/typecheck:** `cd packages/quereus && yarn lint` — clean (eslint + test
  `tsc`).

## Review findings

- **Behavior change worth a look — savepoint-sibling case now rebases.** The old
  sibling detection only checked `pendingLayer.getParent()` directly, so a sibling
  *with intervening savepoint layers* fell through to the non-coordinated `BUSY` /
  coordinated wholesale path. The new fork-point walk (`layerChainSet` + walk up
  from `pendingLayer.getParent()`) finds the true common ancestor through savepoint
  layers, so those now rebase too. Strictly more correct, and the full suite passes,
  but no test targets the savepoint-sibling combination specifically — a reviewer
  wanting belt-and-suspenders could add one (SAVEPOINT mid-transaction on the
  second connection, then a sibling commit).
- **Behavior change — schema drift under a coordinated commit now aborts with
  `BUSY`.** Previously Case C's coordinated path did a wholesale overwrite
  regardless of schema; the rebase path refuses to replay stale-schema rows and
  throws `BUSY` instead. Safer (no stale-schema corruption) but it will roll back
  the whole coordinated `COMMIT`. Untested directly (needs an `ALTER TABLE`
  consolidating the base mid-transaction while a sibling has a pending layer) —
  low-frequency, flagged rather than covered.
- **Event-walk bound tightened in the rebase case.** Event gathering moved inside
  the commit lock and is now bounded at the fork point (Case B) instead of walking
  to `null`. This removes a latent double-emit of already-committed ancestor events
  that the old pre-lock walk could hit on the sibling path. No event-emission test
  exercises the sibling path, so this is unverified beyond "existing event tests
  still pass" — a reviewer could add a data-listener assertion on a sibling commit.
- **Tripwire (parked as `NOTE:`, not a ticket) — own-write log allocation.**
  `TransactionLayer.ownWrites` is an always-on per-layer array (one entry per
  structural write). Fine now; if write-heavy transactions ever show memory
  pressure, collapse it to a PK-keyed last-write map (only the net per-PK effect is
  replayed). Parked at the field in `transaction.ts`.
- **Tripwire (parked as `NOTE:`) — cross-sibling conflict is undetected by design.**
  Contended PK / secondary-`UNIQUE` between two siblings resolves last-writer-wins
  with no error. This is the read-your-own-writes model, not a defect; if a use case
  ever needs cross-connection conflict detection it belongs in `quereus-isolation`,
  not here. Parked at the replay site in `manager.ts`.

## Known gaps (reviewer: treat tests as a floor)

- Coverage is INSERT/UPDATE/DELETE siblings + three-way chain. Not covered:
  savepoint-sibling interaction, schema-drift-during-coordinated-commit, and the
  event-emission path under a sibling commit (all called out above).
- The rebase reconstructs the pending layer's writes via replay, not by moving the
  original BTrees (inheritree exposes no base-swap/rebase primitive — confirmed
  against `node_modules/inheritree/dist/b-tree.d.ts`: only `clearBase`/`flatten`/
  `buildFrom`). Replay cost is O(writes in the rebased branch); large sibling
  transactions rebasing repeatedly is the theoretical worst case, untested for
  performance.
