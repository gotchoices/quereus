description: The browser storage plugin and the server storage plugin are supposed to behave identically behind the same interface, but the browser one has several bugs that make it load everything into memory at once, re-apply the same writes twice, get permanently stuck after a single failed open, and crash under concurrent setup; fix these so the two behave the same.
files:
  - packages/quereus-plugin-indexeddb/src/store.ts (iterate ~line 156; batch reuse ~line 263)
  - packages/quereus-plugin-indexeddb/src/manager.ts (failed-open caching ~line 79; upgrade serialization ~line 191)
  - packages/quereus-plugin-leveldb/src/store.ts (the streaming reference implementation)
  - packages/quereus-plugin-leveldb/src/manager.ts (reference open/upgrade behavior)
difficulty: medium
----

## Problem

The IndexedDB storage plugin and the LevelDB storage plugin implement the **same
key-value store contract** and are meant to be drop-in interchangeable. The
IndexedDB implementation diverges from its LevelDB twin in four ways, each a real
robustness bug in the browser path:

### a) `iterate` materializes the full result set

`store.ts` (~line 156): iteration reads the entire matching key range into memory
and then yields from it, whereas the LevelDB store *streams*. On a large table
this defeats the point of an iterator — memory scales with result size instead of
staying bounded. Bring it in line with the streaming LevelDB behavior (IndexedDB
cursors support incremental iteration; use a cursor rather than `getAll`).

### b) Write batch is not cleared after commit → double-apply

`store.ts` (~line 263): after a batch is written, the batch buffer is not cleared,
so a reused batch object re-applies its previously committed operations on the next
write. Any caller that reuses a batch handle silently writes the same mutations
twice. Clear the accumulated operations once the batch commits.

### c) A failed open is cached forever

`manager.ts` (~line 79): if opening the database fails once, the failed result is
cached, so every subsequent open returns the same failure — the store is
permanently poisoned even after the transient cause is gone. Do not cache a
rejected/failed open; allow a later open attempt to retry.

### d) Racy upgrade serialization → `VersionError`

`manager.ts` (~line 191): concurrent open/upgrade attempts are not serialized, so
overlapping `onupgradeneeded` transactions collide and throw IndexedDB
`VersionError`. Serialize open+upgrade so concurrent callers don't race the version
transition.

## Expected outcome

The IndexedDB store behaves like the LevelDB store for the same operations:
iteration streams with bounded memory, a committed batch does not re-apply on
reuse, a transient open failure can recover on retry, and concurrent setup does not
throw `VersionError`. No behavioral difference an interchangeable-store consumer
could observe between the two backends for these paths.

## Use case / reproduction direction

Each bug wants a focused test in the IndexedDB package (a fake-indexeddb harness in
Node, or the browser-env execution tracked in the test-tooling plan):

- **(a)** iterate a large range and assert memory/behavior is incremental, not a
  single up-front `getAll`.
- **(b)** write a batch, reuse the same batch handle for a second write, assert the
  first batch's operations are not applied a second time.
- **(c)** force the first open to fail, then open again and assert it can succeed.
- **(d)** fire N concurrent opens that trigger an upgrade and assert none throw
  `VersionError`.

## Related — shared conformance suite

These bugs exist because "the two stores must behave identically" is asserted only
in prose, never tested. A shared **KVStore conformance suite** run against LevelDB,
IndexedDB, and the in-memory store would have caught (a)-(d) and prevents the next
divergence. That suite is scoped separately in `test-kvstore-conformance-suite`
(prereq/sibling) — this ticket fixes the concrete bugs; the suite ticket builds the
harness that would have caught them. Cross-reference, don't duplicate.
