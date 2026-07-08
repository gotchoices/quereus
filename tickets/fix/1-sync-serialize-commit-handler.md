description: Two database commits happening close together can be processed out of order because the code that records each commit into the change log is started but never waited for, which can corrupt the ordering guarantee the change log depends on.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts   # line ~255 — void manager.handleTransactionCommit(batch)
  - packages/quereus-sync/src/sync/manager.ts              # collectChangesSince (documents the load-bearing invariant)
  - docs/sync.md
difficulty: medium
----

## Problem

Every committed transaction is recorded into the sync change log by
`handleTransactionCommit`, which reads existing state (for de-duplication) and then
writes the new change-log entries via `kvBatch.write()`. `collectChangesSince`
documents an ordering **invariant** that this recording relies on as load-bearing: a
later commit's entries must be written *after* an earlier commit's are durably present.

The call is fired without being awaited:

```
void manager.handleTransactionCommit(batch)   // sync-manager-impl.ts:255
```

Because it is not awaited, two rapid commits can **interleave**. The second commit's
de-duplication reads can run *before* the first commit's `kvBatch.write()` has
completed. The second handler then makes decisions against stale state, and the two
handlers' writes can land out of order — violating the invariant and producing a
change log that does not reflect true commit order. Downstream consumers
(`collectChangesSince`, delta sync) then extract an inconsistent or incorrect change
set.

## Expected behavior

Commit handling must be **serialized**: `handleTransactionCommit` for commit N+1 must
not begin its reads until `handleTransactionCommit` for commit N has fully completed
(through its `kvBatch.write()`). Commits processed strictly in order, one at a time,
so the change log always reflects true commit order and each handler sees the previous
handler's durable writes.

## Direction

- Serialize the handlers through a **promise chain** (a tail promise each new commit
  chains onto), so invocations run sequentially even when triggered in rapid
  succession. Ensure a rejection in one handler is surfaced/logged and does not
  silently break the chain for subsequent commits (do not swallow the exception).
- Remove the unawaited `void` call at `sync-manager-impl.ts:255` in favor of enqueuing
  onto the chain.

## Tests

- Reproducing test: trigger two commits back-to-back synchronously and assert the
  change-log entries are ordered by commit order and the second handler observed the
  first's writes (e.g. dedup state reflects commit N when handling N+1). Under the
  current `void` call the two interleave; under the serialized chain they do not.
