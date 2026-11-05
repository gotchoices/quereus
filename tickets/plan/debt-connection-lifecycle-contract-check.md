description: Nothing checks the sequence of calls a storage module's connection receives, so engine paths that commit twice or begin without finishing go unnoticed until a strict third-party module breaks. State the contract and check it across the existing logic tests.
architecture: docs/invariants.md
files:
  - packages/quereus/src/vtab/connection.ts # contract
  - packages/quereus/src/vtab/test-support/commit-stall.ts # same wrapping seam
  - packages/quereus/test/logic.spec.ts # runs the check
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # attachMaintainedDerivation
  - packages/quereus/src/core/database-transaction.ts # commit snapshot, failed-commit rollback
  - packages/quereus/src/core/database.ts # registerConnection
  - docs/invariants.md
  - docs/module-authoring-transactions.md
----

Found while asking why no test caught GitHub issue #38. A sequential replay of the logic corpus through a throwaway monitor flagged every arm below on a build with the #38 fix. The monitor scripts were not kept; rebuild the check from this description.

The maintainer agreed on 2026-11-04 that the contract is exactly-once, tentatively ("I think so"). If fixing an arm shows that exactly-once costs more than it is worth, route that arm to `blocked/` with what was found instead of weakening the contract quietly.

## Contract

Add as TXN-001 in `docs/invariants.md`, and state it on `VirtualTableConnection` and in `docs/module-authoring-transactions.md`:

- Every begin, commit, rollback and savepoint call the engine makes holds the execution mutex.
- Calls on one connection never overlap.
- A connection receives begin, then savepoint calls at in-range depths, then exactly one commit or rollback, before the next begin. A commit that rejects leaves the connection open, and rollback follows.
- With no statement running, an engine in autocommit means every registered connection is idle.

## Check

A test-support helper wraps connections at `registerConnection`, as `installCommitStall` does, and throws on any violation, naming the connection, the method, its state and the preceding calls. `logic.spec.ts` installs it for every file in memory and store modes and checks the idle rule after each block. One table-driven spec confirms it rejects each illegal sequence, including a commit with the mutex not held. Measured cost of a monitor of this shape: 15.6 s without and 15.9 s with it over 14,149 logic blocks, which was within noise.

## Known violations

Each must be fixed, or the contract changed to allow it with the reason stated:

1. `attachMaintainedDerivation` commits its connection mid-transaction and the engine commits it again. The comment at `materialized-view-helpers.ts` assumes the later commit does nothing. Corpus: `51.7-maintained-table-attach-detach`, 1 hit in each mode.
2. A connection registered during a commit gets `begin()` and no `commit()`, because `commitTransaction` snapshots connections first. Assertion evaluation triggers it on memory; the isolation flush triggers it on store (4,521 left open, 3,439 begun while open).
3. A connection registered during foreign-key or deferred evaluation gets `rollback()` without `begin()` when the commit fails (10 hits on memory).
4. After a failed commit across several connections, a connection whose `commit()` succeeded still receives `rollback()`.

These are inferred, not demonstrated, to break a module with non-idempotent `begin` or `commit`. In-tree modules tolerate them.

Out of scope: `close()` calling `disconnect()` during an awaiting commit, which needs overlap and which this sequential check cannot see. It is recorded on `bug-close-returns-while-statement-still-running`.

Done when both modes pass with no violations and each resolved arm is pinned by the corpus or the table-driven spec.
