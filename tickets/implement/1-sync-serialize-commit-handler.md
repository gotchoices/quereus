description: Two database commits happening close together can be processed out of order because the code that records each commit into the change log is started but never waited for; serialize the handler so commits are recorded strictly one at a time.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # line ~254 — void manager.handleTransactionCommit(batch); handler at ~629
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts  # add reproducing test here
  - packages/quereus-sync/test/helpers/fake-transaction-source.ts  # synchronous commit() delivery — no change needed, but read to understand harness
  - docs/sync.md                                                # Transaction-Based Change Grouping (documents the ordering invariant)
difficulty: medium
----

## Problem (confirmed)

`SyncManagerImpl.create` subscribes to the engine commit boundary and fires the
recording handler **without awaiting it**:

```ts
transactionSource?.onTransactionCommit((batch) => {
  void manager.handleTransactionCommit(batch);   // sync-manager-impl.ts:255
});
```

`handleTransactionCommit` (line ~629) does async **dedup reads** before its single
`kvBatch.write()` (line ~667):

- `recordDataEvent` → `this.tombstones.getTombstone(...)` (line 739) to delete a
  prior stale delete change-log entry.
- `recordColumnVersions` → `this.columnVersions.getColumnVersion(...)` (line 792) to
  delete a prior stale column change-log entry.

Those deletes are what keep the **load-bearing invariant** documented at
`collectChangesSince` (lines ~902-923): *at most one change-log entry survives per
key, and its HLC equals the current version's.* `resolveLogEntry` (line ~977) resolves
each surviving entry against the current version; two surviving entries for one
`(pk, column)` both resolve to the same current version → a duplicate `Change` in the
extracted set and broken transaction-boundary detection downstream.

Because the handler is not awaited, two rapid commits **interleave** deterministically
in the single-threaded event loop: handler N ticks its HLC synchronously, then suspends
at its first `await` (a dedup read); handler N+1 then ticks and runs its own dedup reads
against the **pre-N-write** state; N+1 misses the prior version, skips the dedup delete,
and leaves a stale entry behind. The change log then no longer reflects true commit order
/ current-version state, and `collectChangesSince` + delta sync extract an inconsistent set.

Note the HLC *tick* itself is not the bug — `hlcManager.tick()` (line 641) runs
synchronously before the first `await`, so bases are allocated in order N then N+1. The
defect is the dedup reads observing stale state and the resulting duplicate/stale
change-log entries.

## Expected behavior

Commit handling **serialized**: `handleTransactionCommit` for commit N+1 must not begin
its reads until N's handler has fully completed (through `kvBatch.write()`). Each handler
sees the previous handler's durable writes; the change log always reflects true commit order.

## Direction

Serialize via a **tail-promise chain** on the instance — each new commit chains onto the
previous handler's completion:

```ts
private commitChain: Promise<void> = Promise.resolve();

/** Serialize commit recording: chain each commit onto the prior handler's completion
 *  so N+1's dedup reads see N's durable writes (docs/sync.md ordering invariant). */
private enqueueTransactionCommit(batch: TransactionCommitBatch): void {
  this.commitChain = this.commitChain.then(() => this.handleTransactionCommit(batch));
}
```

Then replace the subscription body (line ~254-256) to enqueue instead of `void`-firing:

```ts
transactionSource?.onTransactionCommit((batch) => {
  manager.enqueueTransactionCommit(batch);
});
```

- `handleTransactionCommit` already wraps its body in try/catch and logs+emits an error
  event (lines 674-680), so the inner path won't reject the chain. **But** do not rely on
  that alone — guard the chain link so any unexpected throw does not silently poison the
  tail for all subsequent commits. Either keep the existing internal try/catch as the
  primary handler and add a defensive `.catch(err => console.error(...))` on the chain
  link, or equivalent. Do **not** swallow silently — log at minimum (AGENTS.md: no silent
  exception eating).
- The listener still returns `void` to the caller (fire-and-forget from the engine's
  perspective) — only the *ordering* between handlers changes. Existing tests' `settle()`
  (10ms sleep) still drains the chain.

### Optional test hook

Consider exposing the tail for deterministic test draining instead of the 10ms sleep, e.g.
a `whenCommitsSettled(): Promise<void> { return this.commitChain; }` (or reuse in the new
test). Not required for correctness; only add if it makes the reproducing test cleaner.

## Reproducing test (add to `transaction-commit.spec.ts`)

Trigger two commits **back-to-back synchronously** (no `settle()` between them) that both
touch the same `(pk, column)`, then `settle()` once and assert the change log deduped:

- commit 1: `insert users key=[1] newRow=[1,'Alice']`
- commit 2: `update users key=[1] newRow=[1,'Alice2']` (same pk, `name` column changes;
  supply `oldRow` if the harness needs it to detect the changed cell)
- `await settle()`
- `const sets = await manager.getChangesSince(generateSiteId())`
- Assert **exactly one** change for `(pk=[1], column='name')` — no duplicate. Under the
  current `void` call the two handlers interleave and two change-log entries survive,
  yielding a duplicate; under the serialized chain there is one.

Optionally also assert commit-order observability: N+1's dedup saw N's write (e.g. the
surviving entry's value is `'Alice2'`, and the count of change-log entries for the key is 1).
Keep the assertion black-box via `getChangesSince` — do not reach into `ChangeLogStore`
internals unless needed.

## TODO

- Add `private commitChain` field + `enqueueTransactionCommit` method to `SyncManagerImpl`.
- Replace the `void manager.handleTransactionCommit(batch)` subscription body with an
  `enqueueTransactionCommit` call; add defensive chain-link error logging (don't swallow).
- Add the reproducing test to `transaction-commit.spec.ts` (fails on current `main`, passes
  after the fix).
- Skim `docs/sync.md` § Transaction-Based Change Grouping; add a one-line note that commit
  recording is serialized if the existing prose doesn't already imply it.
- Run: `yarn workspace @quereus/quereus-sync test` (Vitest) and `yarn lint`.
