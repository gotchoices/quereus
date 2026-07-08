description: The project has three interchangeable storage backends (in-memory, server LevelDB, browser IndexedDB) that are supposed to behave identically, but each is tested on its own and nothing checks they actually agree, so they have quietly drifted apart; build one shared test suite that runs the same checks against all three.
prereq: plugins-indexeddb-diverges
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-leveldb/src/store.ts
  - packages/quereus-store/src (in-memory / common store abstraction + encoding)
  - packages/quereus-plugin-leveldb/test (existing per-backend specs as a starting point)
  - packages/quereus-plugin-indexeddb/test
difficulty: medium
----

## Problem

Quereus has three implementations of the same key-value store contract that are
meant to be interchangeable behind that contract:

- the in-memory store,
- the LevelDB store (`quereus-plugin-leveldb`),
- the IndexedDB store (`quereus-plugin-indexeddb`).

Each is exercised only by its own package's tests. Nothing runs the *same*
behavioral checks against all three and asserts they agree. As a direct result the
IndexedDB store has drifted from the LevelDB store in several observable ways
(streaming vs. full-materialization iteration, batch reuse double-applying, failed
opens cached forever, racy upgrades) — see `plugins-indexeddb-diverges`, which
fixes those specific bugs. Without a shared suite, the next divergence ships the
same way.

This is also entangled with the persisted-key-encoding correctness work
(`json-canonical-key-hashing`): whether two logically-equal values encode to the
same stored key is exactly the kind of cross-backend invariant a conformance suite
should pin.

## Goal

One reusable **KVStore conformance suite**: a single parameterized set of
behavioral tests, written against the store contract (not any one backend), that is
run against each backend implementation. Any backend that claims to implement the
contract must pass it. New divergences fail the suite instead of reaching users.

## Expected shape (resolve in this plan)

- A backend-agnostic test module that takes a "make a fresh store" factory and
  runs the full battery, invoked once per backend (memory, LevelDB, IndexedDB).
- Coverage of the behaviors that have actually drifted and the contract invariants
  that matter: get/put/delete round-trips, key ordering and range iteration
  (incremental / bounded, not full-materialization), batch atomicity **and** batch
  reuse-after-commit, open/close lifecycle including recovery from a failed open,
  concurrent open/upgrade, and — coordinating with `json-canonical-key-hashing` —
  that logically-equal values encode to equal keys and unequal to unequal, the same
  way on every backend.
- A decision on **how IndexedDB runs in the suite**: a Node fake-indexeddb harness
  vs. real browser-environment execution. This overlaps with the "no
  browser-environment execution for the IndexedDB plugin" gap noted in
  `test-coverage-and-build-tooling`; pick the approach here and note the
  cross-reference rather than solving browser-env twice.

## Open questions to settle before emitting implement tickets

- Where the shared suite lives so all three packages can import it without a
  circular dependency (a small shared test-support module vs. co-located in
  `quereus-store`).
- Whether the in-memory store currently satisfies the same contract surface, or
  whether the suite will surface in-memory gaps too (expected and desirable).
- Node-harness vs. browser-env for IndexedDB (see above).

## Non-goals

- Fixing the individual IndexedDB bugs — that is `plugins-indexeddb-diverges`.
- The key-encoding correctness fix itself — that is `json-canonical-key-hashing`;
  this suite only *checks* cross-backend agreement of the outcome.
