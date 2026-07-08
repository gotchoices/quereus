description: Database commits were recorded into the sync change log without waiting for the previous one to finish, so two rapid commits could interleave and leave a stale duplicate entry; the recording is now serialized so commits are processed strictly one at a time.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # commitChain field, enqueueTransactionCommit, whenCommitsSettled, subscription body
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts # new reproducing test
  - docs/sync.md                                               # § Write side — "Commit recording is serialized" note
difficulty: medium
----

## What changed

Serialized `SyncManagerImpl` commit recording via a tail-promise chain so commit N+1's
dedup reads observe commit N's durable KV writes. Prior code void-fired
`handleTransactionCommit`, so two commits close together interleaved at the first `await`
(a dedup read) and left a stale change-log entry, violating the *at most one surviving
change-log entry per key* invariant that `collectChangesSince` relies on.

Concretely:

- **`sync-manager-impl.ts`**
  - Added `private commitChain: Promise<void> = Promise.resolve();` field.
  - Added `enqueueTransactionCommit(batch)`: chains `handleTransactionCommit` onto
    `commitChain`, with a defensive `.catch(err => console.error(...))` on the chain link
    so an unexpected throw can't poison the tail for all subsequent commits (does not
    swallow silently — logs). `handleTransactionCommit` keeps its own internal try/catch
    (primary handler); the chain `.catch` is the belt-and-suspenders guard.
  - Added `whenCommitsSettled(): Promise<void> { return this.commitChain; }` — a
    deterministic drain hook for tests/diagnostics (not required for correctness; the new
    test uses the existing `settle()` sleep to stay mechanism-agnostic).
  - Replaced the `create()` subscription body: `void manager.handleTransactionCommit(batch)`
    → `manager.enqueueTransactionCommit(batch)`. Listener still returns `void` to the
    engine (fire-and-forget); only inter-handler ordering changed.
- **`transaction-commit.spec.ts`** — new `describe('commit recording is serialized ...')`
  with one test (details below).
- **`docs/sync.md`** — added a "Commit recording is serialized" paragraph under
  § Transaction-Based Change Grouping → *Write side*.

## Why the reproducing test uses the DELTA path (important — subtle)

The ticket suggested asserting via `getChangesSince(generateSiteId())` (no `sinceHLC`).
That call routes to `collectAllChanges`, which reads the **column-version store** — keyed
by `(schema, table, pk, column)`, so it is *deduped by key* and would hide the duplicate.
The interleave bug corrupts the **change LOG** (multiple entries per key), which is read
only by `collectChangesSince` — the delta path, reached by passing a `sinceHLC`.

So the test calls `getChangesSince(peer, fromZero)` where `fromZero = createHLC(0n, 0, …)`
forces the delta scan over the change log. A same-key duplicate then resolves twice via
`resolveLogEntry` (both point at the current column version) → two identical `ColumnChange`
entries pre-fix; exactly one post-fix.

## Reproducing test (use cases / validation)

`transaction-commit.spec.ts` → `'two back-to-back commits on the same (pk, column) dedup to one change-log entry'`:

1. `source.commit` insert `users key=[1] newRow=[1,'Alice']`.
2. **No `settle()` between** — immediately `source.commit` update
   `users key=[1] oldRow=[1,'Alice'] newRow=[1,'Alice2']` (only `name` changes).
   `FakeTransactionSource.commit` delivers synchronously, so both handlers enqueue
   back-to-back — exactly the interleave window.
3. `await settle()`, then `getChangesSince(peer, fromZero)`.
4. Assert **exactly one** `ColumnChange` for `(pk=[1], column='name')`, value `'Alice2'`.

Pre-fix: commit 2's `getColumnVersion('name')` runs against pre-commit-1 state → misses the
prior version → no dedup delete → two `name` change-log entries survive → assertion sees
length 2 and fails. Post-fix: serialized, commit 2 sees commit 1's write → one entry.

## Validation performed

- `yarn workspace @quereus/sync test` → **433 passing, 0 failing** (Mocha, min reporter).
  The `[Sync] Error handling transaction commit: ...` lines in output are OTHER tests'
  injected-failure paths (`sync-manager.spec.ts` failing-KV cases), not regressions.
- `yarn workspace @quereus/sync typecheck` (`tsc --noEmit`) → exit 0.

## Reviewer notes / known gaps (treat tests as a floor)

- **Ticket header inaccuracies I corrected:** workspace is `@quereus/sync` (ticket said
  `@quereus/quereus-sync`), and the runner is **Mocha + chai**, not Vitest as the ticket
  claimed. Commands above are the real ones.
- **Test-file types are NOT enforced by CI here.** `packages/quereus-sync/tsconfig.json`
  excludes `test/`, and Mocha runs via a type-stripping register — so a type error in the
  spec would not fail the suite. I verified the new test's types by hand against
  `protocol.ts` (`Change = ColumnChange | RowDeletion`, `ChangeSet.changes: Change[]`), and
  the type-guard `(c): c is ColumnChange` is a valid narrowing. Worth a second look if you
  care about spec type-safety; consider whether test/ should be in a `typecheck` scope
  (out of scope for this ticket).
- **Single-test coverage.** Only the one same-key insert-then-update case is covered. Not
  covered: delete→reinsert→delete key reuse across rapid commits (the tombstone dedup path
  in `recordDataEvent`), 3+ commits deep, or mixed multi-table rapid commits. The tombstone
  path has the same interleave shape and the same fix covers it, but there is no dedicated
  regression test for it. Reasonable to add if the reviewer wants breadth.
- **`whenCommitsSettled` is added but only lightly exercised** (not used by the new test).
  It is a thin accessor over `commitChain`; low risk, but unused-by-tests.
- **Error-path behavior unchanged:** the chain `.catch` logs and continues; a failed
  commit does not stop later commits from recording. This matches prior fire-and-forget
  semantics (a void-fired rejection was already unobserved) — no behavior regression, and
  now it is explicitly logged rather than an unhandled rejection.
- **No `NOTE:`/tripwire comments added** — nothing conditional surfaced; the serialization
  is unconditional and the invariant is already documented at `collectChangesSince`.
