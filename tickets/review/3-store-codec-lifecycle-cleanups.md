description: Review a store-package pass that fixes a failed-commit row-count leak, makes table rename carry its statistics, and de-duplicates a byte-to-hex helper plus a per-call encoder allocation.
prereq: store-tablekey-split-mis-routes-dotted-identifiers
files:
  - packages/quereus-store/src/common/transaction.ts            # commit() — failure now fires onRollback for all callbacks
  - packages/quereus-store/src/common/store-module.ts           # renameTable (~2070) — stats re-keyed old→new
  - packages/quereus-store/src/common/serialization.ts          # hoisted module-level textEncoder
  - packages/quereus-store/src/common/bytes.ts                  # lookup-table bytesToHex + NOTE on main-pkg dups
  - packages/quereus-store/src/common/cached-kv-store.ts        # private toHex removed → routes through bytesToHex
  - packages/quereus-store/src/common/memory-store.ts           # keyToHex now aliases bytesToHex
  - packages/quereus-store/test/transaction.spec.ts             # commit-failure stats-clear tests (new describe)
  - packages/quereus-store/test/rename-stats-migration.spec.ts  # NEW — rename keeps row count (unified-stats provider)
  - packages/quereus-store/test/bytes.spec.ts                   # NEW — hex output + ordering invariant
difficulty: medium
----

# Review: store codec + lifecycle cleanups

Four store-package changes. **Item 1 is the correctness fix and the priority.**
Items 2–4 are mechanical/hygiene. Build, `yarn lint`, and the full `yarn test`
(6896 + 910 + downstream packages) all pass; the full store suite is 910 passing,
0 failing.

## What changed and why it's correct

### Item 1 — failed commit no longer leaks stats deltas (CORRECTNESS)
`TransactionCoordinator.commit` (`transaction.ts`) buffered per-table row-count
deltas during a transaction; each `StoreTable` registers
`{onCommit: applyPendingStats, onRollback: discardPendingStats}`. If the write (or
event/commit-callback loop) threw, control jumped to `finally → clearTransaction()`
firing **neither** callback, so `pendingStatsDelta` survived into the *next*
transaction on the module-wide coordinator and was double-counted.

Fix: a `notified` flag. The `try` sets `notified = true` only after every
`onCommit` ran clean; the `finally` fires `onRollback` for **every** callback when
`notified` is false, before `clearTransaction()`. Invariant: **a commit that throws
leaves every callback's pending delta at 0.** The explicit `rollback()` path is
untouched and does not double-fire (a successful commit sets `notified` and skips
the finally loop).

Documented tradeoff (inline): if `onCommit` throws on callback *k*, callbacks
`0..k-1` already applied+zeroed (so a follow-up `onRollback` is a no-op on them)
and `k..n` are discarded — some-cleared-and-consistent beats leaking all.
`applyPendingStats` doesn't throw in normal operation, so this is a defensive
corner.

### Item 2 — rename migrates statistics instead of deleting them
`renameTable` (`store-module.ts` ~2070) previously `delete`d the old stats key and
never wrote the new one, so a renamed table reported `getEstimatedRowCount() === 0`
until re-gathered. Now: read old key → if present, `put` under the new key → delete
old key, all inside the existing best-effort try/catch (stats never block a rename).
`dispose()` earlier in `renameTable` flushes any buffered delta under the old key,
so the read sees the current estimate even for a row count below the flush
threshold (100).

**The real providers (leveldb/indexeddb/native) share ONE unified `__stats__`
store keyed by `schema.table`** — `getStatsStore` ignores its table argument. That
is why the entry is re-keyed, not physically moved.

### Item 3 — one hoisted `TextEncoder`
`serialization.ts` allocated `new TextEncoder()` per call at three sites
(`serializeRow`, `serializeValue`, `serializeStats`). Now a single module-level
`textEncoder` reused at all three. `TextEncoder` is stateless. `TextDecoder` sites
left as-is (scope was the encoder churn).

### Item 4 — one fast `bytesToHex`, two dup helpers removed
`bytes.ts` `bytesToHex` is now a 256-entry lookup-table impl (lowercase, 2-char,
zero-padded — byte-identical output to before). `cached-kv-store.ts`'s private
`toHex` was deleted and its call sites route through `bytesToHex`;
`memory-store.ts`'s `keyToHex` is now a one-line alias of `bytesToHex` (kept as an
alias so the 8 call sites and the `compareHex` ordering comment stay coherent).

**Ordering invariant preserved:** `InMemoryKVStore` orders keys by string compare
and depends on the `[0-9a-f]` lowercase alphabet matching unsigned-byte order.
`bytes.spec.ts` asserts both the exact output (`[0x00,0x0f,0xa0,0xff] → "000fa0ff"`)
and that hex string order equals `compareBytes` sign across boundary samples.

## How to exercise / validate

- **Commit-failure leak (item 1):** `transaction.spec.ts` →
  `describe('commit failure clears pending callback state ...')`. Covers atomic
  path AND fallback (no-factory) path, two tables in one transaction, and asserts
  the *next* transaction starts from the pre-failure baseline (committed === 2, not
  3 + 2). Also a clean-commit test that `onRollback` never runs.
- **Rename keeps row count (item 2):** `rename-stats-migration.spec.ts` uses a
  UNIFIED-stats provider (mirrors the shipped providers, unlike the per-table
  provider in `coordinator-callback-leak.spec.ts`), inserts N=5 rows (below the
  100-row flush threshold), renames, and asserts the persisted `rowCount` under the
  new name is N and the old key is gone. Second test: rename of a never-written
  table leaves no spurious zero-count entry.
- **Hex stability (item 4):** `bytes.spec.ts` (see above).
- Commands: `yarn workspace @quereus/store run test` (full store suite),
  `yarn build`, `yarn lint`, `yarn test` (whole monorepo) — all green here.

## Known gaps / where to look hard (reviewer: treat tests as a floor)

- **`yarn test:store` (LevelDB-backed) was NOT run** — memory-backed `yarn test`
  only. Item 2 is the one that most warrants it (rename + real unified stats store
  on a real provider). Recommend a spot-run of the rename/stats paths against
  `test:store` if cheap; the unified-stats test provider models the real layout but
  is not the real store.
- **Item 1 end-to-end variant deferred.** The tests are coordinator-level with a
  faithful stats-callback model, not a real `StoreTable` DML whose commit is forced
  to fail. The stronger end-to-end form (drive a DML statement to a failing commit,
  then assert the next `getEstimatedRowCount()` baseline on the real table) was not
  added — reaching a live `StoreTable` instance from a test and forcing its commit
  to throw is fiddly. The coordinator model exercises the exact fixed code path, but
  a reviewer wanting belt-and-suspenders could add the DML-level test.
- **Item 2 provider-shape assumption (tripwire, parked as a `NOTE:` at
  `store-module.ts` ~2070).** The re-key reaches the old value only when
  `getStatsStore(newName)` returns a store containing the old key — true for unified
  stores and for providers that physically relocate a per-table stats store. A
  provider with per-table stats stores that are NOT relocated by `renameTableStores`
  would orphan the value (the old delete-only code lost it too — no regression). No
  shipped provider does this.
- **Main-package hex duplication (tripwire, parked as a `NOTE:` at the top of
  `bytes.ts`).** ~10 other byte→hex encoders live in `packages/quereus`
  (`util/serialization.ts`, `util/key-tuple-codec.ts`,
  `vtab/memory/utils/primary-key-encode.ts`, `planner/analysis/*`). Deliberately out
  of scope — different package, different key concerns — recorded for a future
  cleanup, not filed as a ticket.

## Out of scope (split into sibling tickets — do not pull in)
- `store-altertable-decompose` (implement, seq 4) — the 565-line `alterTable`
  refactor. Chained after this ticket (both edit `store-module.ts`).
- `store-stream-large-rewrites` (plan, seq 5) — streaming large in-place rewrites;
  routed to plan because it trades away all-or-nothing batch semantics.
- The `tableKey.split('.')` dotted-identifier mis-route is the `prereq`
  (`store-tablekey-split-mis-routes-dotted-identifiers`) — separate correctness bug.
