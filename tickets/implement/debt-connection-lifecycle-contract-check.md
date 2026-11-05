description: The engine sometimes commits a storage module's connection twice, rolls back one it never began, or begins one and never finishes it, and nothing notices until a strict third-party module breaks. Fix those paths, write down the rule, and check it across the existing logic tests.
architecture: docs/invariants.md
files:
  - packages/quereus/src/core/database-transaction.ts # open-connection tracking, closing flag, commit and rollback, early commit
  - packages/quereus/src/core/database.ts # registerConnection, _commitConnectionEarly, remove the unused deferred-evaluation surface
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # the conn.commit() in attachMaintainedDerivation and in rebuildBacking
  - packages/quereus/src/vtab/connection.ts # contract comments
  - packages/quereus/src/vtab/test-support/connection-lifecycle-check.ts # new
  - packages/quereus/src/vtab/test-support/commit-stall.ts # the same wrapping seam, to copy
  - packages/quereus/src/index.ts # export the check beside installCommitStall
  - packages/quereus/test/logic.spec.ts # installs and runs the check
  - packages/quereus/test/core/connection-lifecycle-check.spec.ts # new
  - packages/quereus/test/core/overlapping-statement-finalize.spec.ts # line 140 asserts the old behaviour
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic # two new blocks
  - scripts/check-docs.mjs # the area list on line 366 needs TXN
  - docs/invariants.md
  - docs/doc-conventions.md # area list needs TXN
  - docs/module-authoring-transactions.md
  - docs/materialized-views.md # two sentences on commit-first
difficulty: hard
----

Found while asking why no test caught GitHub issue #38. The maintainer agreed on 2026-11-04 that the contract is exactly-once, tentatively. Planning found that exactly-once is cheap to reach, so nothing here weakens the contract. If implementing an arm shows otherwise, route that arm to `blocked/` with what was found.

## The contract

Goes in `docs/invariants.md` as TXN-001, on `VirtualTableConnection`, and in `docs/module-authoring-transactions.md`:

- Every begin, commit, rollback and savepoint call the engine makes holds the execution mutex.
- Calls on one connection never overlap.
- A connection receives begin, then savepoint calls at in-range depths, then exactly one commit or rollback, before the next begin. A commit that rejects leaves the connection open, and rollback follows.
- With no statement running, an engine in autocommit means every registered connection is idle.

Two consequences module authors need, for the module doc:

- A connection registered while a transaction is closing (assertion and deferred-constraint evaluation, the commit loop, post-commit watchers, rollback) receives no calls for that transaction. It joins at the next begin. A module that writes through such a connection during a commit drives that write itself, as the isolation layer's flush does through `VirtualTable.begin` and `commit`.
- A begin that rejects fails the statement that caused it, and the connection stays idle.

The check sees only calls on the object passed to `registerConnection`. Calls a wrapper makes on connections inside it (`IsolatedConnection` on its overlay and underlying, `StoreTable.commit` on the shared coordinator) are the wrapper's own business. Say so in the module doc.

## What the engine does now, measured

A throwaway monitor over the logic corpus on this HEAD, wrapping connections at `registerConnection`. Runs with the monitor took about 24 s on memory and about 1 min on store. This planning pass did not time runs without it; the earlier 15.6 s against 15.9 s over 14,149 blocks, measured for a monitor of this shape, is the only overhead figure.

| Violation | Memory | Store | Cause |
|---|---|---|---|
| begin while open | 1 | 3,425 | Arm 2 |
| open with no statement running | 0 | 10,265 checks | Arm 2 |
| rollback while idle | 10 | 1 | Arm 3 |
| commit while idle | 1 | 1 | Arm 1 |
| Mutex not held, overlap, out-of-range savepoint | 0 | 0 | none |

Arm 4 never fires in the corpus, because no logic test makes a commit reject. Arm 1 has a second site and a savepoint variant that the corpus also misses. Both were reproduced by running the two blocks in *Corpus pins* below in both modes.

## Design

### Tracking which connections are open

`TransactionManager` gains `openConnections: Set<VirtualTableConnection>`, holding the connections it has begun and not yet finished. All engine commit and rollback calls go through it. The set is cleared at the end of every transaction. Connections removed from the registry mid-transaction stay out of it because participants are read as `ctx.getAllConnections().filter(c => openConnections.has(c))`, so the existing removal paths need no new notification.

Savepoint broadcasts stay as they are. Every registered connection is open during a broadcast, and the check fails if that ever stops being true.

### Arm 2: registered during a commit gets begin and no commit

Replace `evaluatingDeferredConstraints` with one `closingTransaction` flag. It is set at the top of `commitTransaction` and `rollbackTransaction` and cleared in their `finally`. `registerConnection` begins a connection only when in a transaction and not closing.

This extends what deferred evaluation already did. The rejected alternative was committing late arrivals in a second pass. That would give the store's flush connection a second commit on a transaction the flush has already committed, and it would need another pass after post-commit watchers.

Reads stay correct because a table with pending writes already has a connection, which memory and isolation both reuse. A new connection therefore only reads a table this transaction has not written, where committed rows are the right answer.

The deferred flag is only ever true inside `commitTransaction`, so it goes away. Remove `TransactionManager.runDeferredRowConstraints`, `isEvaluatingDeferredConstraints`, `Database.runDeferredRowConstraints`, `Database._isEvaluatingDeferredConstraints` and the context interface member. `commitTransaction` calls `ctx.getDeferredConstraints().runDeferredRows()` directly. None of these has another caller in `packages/*/src` or `packages/*/test`.

### Arms 3 and 4: rollback to the wrong connections

Commit iterates the open participants, removing each from the set when its commit resolves. A rejected commit stays in the set. Both rollback paths use one shared helper over the open participants. It wraps each call so a synchronous throw cannot skip the others, and logs failures, as `rollbackTransaction` already does. Today's commit-failure path, `conns.map(c => c.rollback())`, does not have that protection.

A connection that never began now gets no rollback (arm 3), and one whose commit succeeded gets no rollback (arm 4). No in-tree module loses anything by this: on all of them, rollback after a successful commit already does nothing.

### Arm 1: the mid-transaction commits

`attachMaintainedDerivation` and `rebuildBacking` commit one connection ahead of the transaction because later steps read committed rows. That behaviour stays. A helper replaces the bare `conn.commit()` at both sites:

```ts
// TransactionManager, exposed as Database._commitConnectionEarly
async commitConnectionEarly(connection: VirtualTableConnection): Promise<void>
```

- If the connection is not open, throw `QuereusError` with `StatusCode.INTERNAL`. Both callers run after `_ensureTransaction`, so this cannot happen today.
- Call `commit()`, then remove it from the open set.
- Begin it again and replay the active savepoint depths, through the same private join method `registerConnection` uses. The sequence is begin, commit, begin, commit, which the contract allows, and later savepoint calls are in range.
- If `commit()` rejects, roll back the whole transaction and rethrow. A statement-level failure would otherwise leave an explicit transaction running on a connection whose only legal next call is rollback. `commitTransaction` handles a failed commit the same way, and OR ROLLBACK already leaves an explicit transaction closed this way.

Update the comments that say the later commit "no-ops": `materialized-view-helpers.ts` near lines 1483 and 1755. Check `docs/materialized-views.md` lines 165 and 200 still read true.

### Begin failures

`beginTransaction` sets `inTransaction` before its loop, so a connection registered during another connection's `begin()` joins normally. If a `begin()` rejects, it rolls back the connections already begun, discards the event batch, restores autocommit, and rethrows. Today those connections are left open.

`registerConnection` stops swallowing a rejected begin. It removes the connection from the registry and rethrows. With tracking, a swallowed failure would mean no commit for a connection the module may write to, losing those writes silently. A search of the test directories for the two log messages finds nothing, and the simulation did not cover this change, so the test run is what confirms no test depends on the old swallow.

Savepoint replay keeps its log-and-continue, with a NOTE at the site: a rejected replay leaves this connection short of depths; no in-tree module's `createSavepoint` rejects; if one appears, fail the registration and roll back the connection instead.

### The check

`packages/quereus/src/vtab/test-support/connection-lifecycle-check.ts`, exported from `src/index.ts` beside `installCommitStall` so third-party module authors can run it too:

```ts
export interface ConnectionLifecycleCheck {
	/** Every violation recorded so far. */
	readonly violations: readonly string[];
	/** Throws if any violation was recorded or, with no statement running in autocommit, a registered connection is open. */
	assertClean(): void;
}
export function installConnectionLifecycleCheck(db: Database): ConnectionLifecycleCheck;
```

It wraps connections when `registerConnection` is called, as `installCommitStall` does, once per connection object. It leaves `disconnect` alone.

| State | Legal call | Result |
|---|---|---|
| idle | `begin` | open, depth 0 |
| open | `createSavepoint(d)` with `d === depth` | depth `d + 1` |
| open | `releaseSavepoint(d)` with `d < depth` | depth `d` |
| open | `rollbackToSavepoint(d)` with `d < depth` | depth `d + 1` |
| open | `commit` resolves | idle |
| open | `commit` rejects | commit-failed |
| open or commit-failed | `rollback` | idle, whether it resolves or rejects |

Anything else is a violation, as is any call with `db._isExecuting()` false or while a previous call on that connection is unsettled. A `begin` that rejects leaves the connection idle.

Requirements:

- **Record and throw.** A violation is recorded, then thrown before the real method runs. Recording matters because the engine swallows some of these throws (`Promise.allSettled`, `_rollbackAndReleaseSavepointBroadcast`).
- **Message.** Names the connection, the table, the method, the state and the last eight calls.
- **Preserve sync and async.** The wrapper returns what the real method returns and adds no ticks. Timing-sensitive specs noticed when the planning monitor added ticks at the statement level.
- **No Node globals.** `src/` also runs in the browser. `test/cross-platform/browser.spec.ts` removes `process`.

`logic.spec.ts` installs it right after `new Database()`, before the store module is registered, and calls `assertClean()` after every block including the end-of-file one, reporting `file:line`.

### Tradeoffs accepted

- A module that begins eagerly on a connection registered during commit now does not get that begin. This is the point of the change, and it is called out in the module doc.
- A rejected begin now fails statements that used to continue with a logged error. No in-tree module rejects a begin.
- Only the logic corpus runs under the check. A spec that drives `_createSavepointBroadcast` with no mutex (`savepoint-broadcast.spec.ts`) is white-box and stays unchecked.

## Evidence for the design

The planning monitor simulated arms 2, 3 and 4 by patching the engine from outside the tree, leaving `src/` unchanged. Arm 1, the begin-failure handling and the check itself were not simulated.

- Logic corpus: 378 passing on memory, 371 passing and 7 pending on store. Begin-while-open and open-with-no-statement both went to 0 on both modes.
- `packages/quereus/test/**/*.spec.ts` without bench, fuzz and logic specs: 10,393 passing, 26 pending, 7 failing. Six are `browser.spec.ts`, caused by the monitor reading `process`. The seventh is `overlapping-statement-finalize.spec.ts:140`, which asserts arm 4's old behaviour.
- Not run: the store, isolation and sync package suites, which import the built `dist`.

## Corpus pins

Append to `51.7-maintained-table-attach-detach.sqllogic`. Both blocks pass on both modes today and produce violations on both, so they pin arm 1 once the check is on.

```sql
-- refresh of a CHECK-bearing maintained table commits its connection early
create table lc_src (id integer primary key, v integer);
insert into lc_src values (1, 1), (2, 2);
create table lc_mt (id integer primary key, v integer check (v > 0)) maintained as select id, v from lc_src;
-- run
refresh materialized view lc_mt;
-- run
select id, v from lc_mt order by id;
→ [{"id":1,"v":1},{"id":2,"v":2}]

-- a retyping attach inside a savepoint: the early commit must leave later savepoint calls in range
create table lc_tgt (id integer primary key, v text);
create table lc_base (id integer primary key, v integer);
insert into lc_base values (1, 5);
-- run
begin;
savepoint lc_s;
-- run
alter table lc_tgt set maintained as select id, v from lc_base;
-- run
release lc_s;
commit;
-- run
select id, v from lc_tgt order by id;
→ [{"id":1,"v":5}]
```

Drop the tables at the end of the block if the file's later sections would collide with them.

## Tests

The corpus under the check pins arm 2 (`95-assertions` on memory, nearly every file on store), arm 3 (`40-constraints`, `41-foreign-keys`) and arm 1 (the two blocks above and the existing `51.7` hit).

`overlapping-statement-finalize.spec.ts:140`: change the expected `connection.rollbacks` to 0, and assert the failing connection received 1. This is the arm 4 pin.

`test/core/connection-lifecycle-check.spec.ts`:

- One table-driven `it` per row, each feeding a fake connection an illegal sequence and expecting a throw and a recorded violation: commit while idle, rollback while idle, begin while open, each savepoint call while idle, each out-of-range depth, a call after a rejected commit other than rollback, an overlapping call, and a commit with the mutex not held. Legal rows acquire the mutex with `_acquireExecMutex`.
- A legal full sequence, including begin, commit, begin, commit, records nothing.
- `assertClean()` throws for an open connection with no statement running.
- `beginTransaction`: the second of two connections rejects its begin. The first gets a rollback, autocommit is true, and the error reaches the caller.
- `registerConnection` inside a transaction with a rejecting begin: rejects, and `getConnection` returns undefined.
- `_commitConnectionEarly` with a rejecting commit: the whole transaction rolls back and the error reaches the caller.

Add nothing beyond these.

## Edge cases & interactions

- Connection registered during assertion evaluation, deferred evaluation, the commit loop, a post-commit watcher, or a rollback: receives nothing until the next begin. Verified by the check over the corpus. The rollback and watcher cases are by inspection, since the flag covers the whole method.
- Report-mode commits (`pendingCommitAssertionSink`, external-row ingestion) go through the same `commitTransaction`. By inspection.
- `alter-table.ts:2401` calls `_commitTransaction` then `_ensureTransaction` inside a statement. This is a whole-transaction close and reopen, so the open set empties and refills. Verified by the check over `alter primary key` corpus files.
- Early commit on the store: `StoreConnection.commit` commits the module-wide coordinator, so other store tables' pending writes commit too. That is today's behaviour. The re-begin reopens the coordinator, so later writes in the transaction have one, and the coordinator's depth-idempotent `createSavepoint` makes replay safe. Verified by the second corpus block in store mode.
- `rollback to` a savepoint after an early commit leaves the committed rows in place, matching the documented "`begin; refresh; rollback` does not undo a refresh". By inspection.
- A failed commit across connections stays non-atomic: earlier connections remain committed, as they are today. By inspection and the updated `overlapping-statement-finalize` assertion.
- The same connection object registered twice: the join is a no-op when it is already open, so no second begin and no second replay. The monitor saw no double registration in the corpus. By inspection.
- Unregistered `_readCommitted` connections never pass through `registerConnection`, so the check does not see them, and they make no transaction calls. By inspection.
- `installCommitStall` and the check can both be installed on a database, since each wraps the previous `registerConnection`. Verified by inspection of the shared seam; `overlapping-statement-finalize.spec.ts` is unaffected since it does not install the check.
- `close()` calling `disconnect()` during an awaiting commit needs overlap, which this sequential check cannot see. It is out of scope and recorded on `bug-close-returns-while-statement-still-running`.
- `bug-watch-handler-awaiting-query-hangs-database` (blocked) touches post-commit watchers. Any work it defers past the mutex runs after the transaction has ended, so the closing flag does not affect it.

## TODO

- Add `openConnections`, `closingTransaction` and the private join method to `TransactionManager`, and route `beginTransaction`, `commitTransaction` and `rollbackTransaction` through them, with the shared rollback helper and begin-failure unwind.
- Remove the deferred-evaluation flag, its wrappers and the context interface member.
- Rewrite `registerConnection` to use the join method, rethrow a rejected begin after removing the connection, and carry the savepoint-replay NOTE.
- Add `commitConnectionEarly` and `Database._commitConnectionEarly`. Use it at `materialized-view-helpers.ts` lines 1486 and 1850 and update the comments there.
- Write `connection-lifecycle-check.ts` and export it from `src/index.ts`.
- Install it in `logic.spec.ts` and call `assertClean()` after every block.
- Append the corpus blocks to `51.7`, change `overlapping-statement-finalize.spec.ts:140`, and add `connection-lifecycle-check.spec.ts`.
- Add TXN to `scripts/check-docs.mjs` line 366 and the area list in `docs/doc-conventions.md`.
- Add a `## TXN — Transactions` section to `docs/invariants.md` with TXN-001, at most 120 words, with `code:` pointers to `TransactionManager` and `Database.registerConnection`, `guard:` naming `packages/quereus/src/vtab/test-support/connection-lifecycle-check.ts`, and `doc:` linking the new section below.
- Add a `## Connection lifecycle` section to `docs/module-authoring-transactions.md` with the contract, its two consequences, the limit of what the check sees, and how to install it. Back-link TXN-001 by its full heading slug. Correct the `registerConnection` row in the `DatabaseInternal` table.
- Add the contract to the `VirtualTableConnection` doc comment in `connection.ts`.
- Run `yarn docs:check`, `yarn lint`, `yarn build`, `yarn test` and `yarn test:store`. `yarn build` must come before `yarn test` because the store, isolation and sync suites import the built `dist`, and those suites have not been run against this design.
