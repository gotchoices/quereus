description: Database commits were recorded into the sync change log without waiting for the previous one to finish, so two rapid commits could interleave and leave a stale duplicate entry; the recording is now serialized so commits are processed strictly one at a time.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # commitChain, enqueueTransactionCommit, whenCommitsSettled, subscription
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts # reproducing test (now drains via whenCommitsSettled)
  - docs/sync.md                                               # § Write side — "Commit recording is serialized" note
difficulty: medium
----

## What shipped

`SyncManagerImpl` now serializes commit recording via a tail-promise chain
(`commitChain`). Each commit chains onto the prior handler's completion through
`enqueueTransactionCommit`, so commit N+1's dedup reads (`getColumnVersion` /
`getTombstone` → `deleteEntryBatch` of the superseded change-log entry) observe commit
N's durable KV writes. Prior code void-fired `handleTransactionCommit`, so two commits
close together interleaved at the first `await` and left a stale change-log entry,
breaking the *at most one surviving change-log entry per key* invariant that
`collectChangesSince` / `resolveLogEntry` rely on.

Also added `whenCommitsSettled()` — a deterministic drain hook returning `commitChain`.

## Review findings

**Verdict: implementation is correct and well-reasoned. One minor inline fix applied; no
new tickets filed.**

### Checked — code correctness (SPP / DRY / error handling / type safety)
- **Serialization mechanism** — `enqueueTransactionCommit` chains `.then(handler).catch(log)`
  and reassigns `commitChain`. Synchronous enqueues (the real interleave window, and how
  `FakeTransactionSource.commit` delivers) chain in delivery order → strict serial
  execution. Confirmed correct.
- **Ordering claim** — traced the dedup site: `recordColumnVersions`
  (sync-manager-impl.ts:823) and the delete branch of `recordDataEvent` (:775) both read
  the prior version then `deleteEntryBatch` the superseded log entry before their single
  `kvBatch.write()`. This is exactly what serialization protects. Matches the LOAD-BEARING
  INVARIANT documented at `collectChangesSince`.
- **Error path — no chain poison** — `handleTransactionCommit` has its own try/catch that
  emits an error sync-state and returns (never rethrows); the chain `.catch` is
  belt-and-suspenders and logs. A failed commit N (atomic `kvBatch.write` → nothing
  durable) does not block N+1, and N+1 dedups against last-successful state. Correct, and
  a strict improvement over the prior unobserved void-fired rejection.
- **Memory/backpressure** — serial chain is strictly *better* than the prior unbounded
  concurrent void-fire; not a regression. No tripwire warranted.
- **Type safety** — no `any`; `TransactionCommitBatch` typed. Clean.

### Checked — tests
- Reproduction logic verified by hand: pre-fix, both handlers interleave at the first
  `await getColumnVersion`, commit 2 misses commit 1's `name` version → two `name`
  change-log entries both resolve to the current cv → assertion `length 1` **fails**
  pre-fix, passes post-fix. Genuine regression guard.
- The DELTA-path rationale (from-zero `sinceHLC` → `collectChangesSince`, not
  `collectAllChanges`) is correct: the by-key column-version store the snapshot path reads
  would hide the duplicate; only the change LOG carries it.

### Found & fixed inline (minor)
- **Test drained via a 10 ms `setTimeout` while a deterministic `whenCommitsSettled()`
  hook now exists** — flaky-prone, and left the new public API untested. Switched the new
  test to `await manager.whenCommitsSettled()` (both commits enqueue synchronously before
  the await, so it drains both handlers through their KV writes deterministically). Removes
  the timing dependence and gives the hook coverage. Re-ran: **433 passing**; test files
  typecheck clean.

### Noted, not filed (out of scope / breadth)
- **Sync spec types are not CI-enforced.** `@quereus/sync`'s `lint` is a no-op and its
  `typecheck` script runs `tsconfig.json` (excludes `test/`); a `tsconfig.test.json` exists
  but no script invokes it. I manually ran `tsc -p tsconfig.test.json --noEmit` → clean, so
  the current specs are type-safe. Wiring test-type-checking into CI is a **pre-existing,
  repo-wide infra gap** (most packages ship a no-op lint), not caused by this change — left
  for a human to weigh a repo-wide `typecheck:test` convention rather than filing a
  sync-only ticket.
- **Tombstone interleave path (delete→reinsert→delete key reuse) has no dedicated
  regression test.** It has the same interleave shape as the column path and the same
  serialization fix covers it unconditionally; only breadth coverage is missing, not
  correctness. Not filed — the fix demonstrably covers it and the column-path test guards
  the mechanism.

### Docs
- `docs/sync.md` § Transaction-Based Change Grouping gained an accurate "Commit recording
  is serialized" paragraph. Read the touched section; it reflects the new reality.

## Validation performed
- `yarn workspace @quereus/sync test` → **433 passing, 0 failing** (Mocha). The
  `[Sync] Error handling transaction commit: …` lines are `sync-manager.spec.ts`
  injected-failure cases, not regressions.
- `yarn workspace @quereus/sync typecheck` → exit 0.
- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` (test files) → exit 0.
