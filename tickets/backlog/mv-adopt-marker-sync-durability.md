description: Clean-shutdown marker single-use property can fail under power loss — the consume-side delete and the session's data writes flush independently across separate KV stores, so a lost delete resurrects the marker across a genuine crash window.
difficulty: hard
files:
  - packages/quereus-store/src/common/store-module.ts        # consumeCleanShutdownMarker (read + delete at open); closeAll marker write
  - packages/quereus-store/src/common/kv-store.ts            # KVStore contract — no durability/sync surface today
  - packages/quereus-plugin-leveldb/src/store.ts             # classic-level put/del without { sync: true }
  - packages/quereus-plugin-indexeddb/                       # other providers need the same treatment
  - docs/materialized-views.md                               # § Cross-module atomicity: caveat documented, to be removed when fixed
----

# Marker consume must be at least as durable as subsequent data writes

## Problem

The adopt fast path's safety argument rests on the clean-shutdown marker being
**single-use**: `rehydrateCatalog` reads it and deletes it immediately, so a
crash later in the session leaves no marker and the next open refills.

That argument holds for a process kill (the delete reaches the OS page cache
and survives), but not for power loss: the catalog store and the per-table data
stores are *separate* KV stores (separate LevelDB databases, separate WALs),
each flushed independently and — in the LevelDB plugin — without `sync: true`.
There is no ordering guarantee between them. A power loss can persist a data
write from mid-session while losing the earlier marker delete in the catalog
store. The next open then finds the marker, trusts every backing, and adopts
across a genuine crash window — exactly the divergence the marker exists to
exclude, and it never self-heals (each subsequent clean close re-arms it).

## Expected behavior

The marker-consume delete must be durably persisted before any of the session's
data writes can become durable. Equivalently: if any post-open write survived a
power loss, the marker delete must have survived too.

## Specification sketch

- Extend the `KVStore` write surface with an opt-in durability flag (e.g.
  `put/delete(key, { sync?: boolean })` or a `flush(): Promise<void>` barrier),
  implemented per provider: classic-level supports `{ sync: true }` natively;
  IndexedDB transactions are durable at `oncomplete` (with
  `durability: 'strict'` where supported); in-memory stores no-op.
- `consumeCleanShutdownMarker` issues the delete with the durability flag (or
  follows it with `flush()`); the close-side marker *write* can stay unsynced —
  losing it is conservative (next open refills).
- Cost is one synced write per open — not on any hot path.
- Alternatively (bigger): co-locate the marker and data in one store / one
  atomic batch domain; subsumed by `store-atomic-multi-store-commit` if that
  lands first.

Remove the corresponding caveat bullet from `docs/materialized-views.md`
§ Cross-module atomicity when this lands.
