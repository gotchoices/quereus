description: Fix a power-loss bug where a clean-shutdown marker can survive a crash and make the database trust stale data on reopen, by forcing the marker's deletion to disk before any new writes.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts            # KVStore.put/delete write surface
  - packages/quereus-store/src/common/memory-store.ts        # InMemoryKVStore (no-op sync)
  - packages/quereus-store/src/common/store-module.ts        # consumeCleanShutdownMarker (~line 2151)
  - packages/quereus-plugin-leveldb/src/store.ts             # classic-level { sync: true }
  - packages/quereus-plugin-indexeddb/src/store.ts           # IDB durability
  - docs/materialized-views.md                               # § Cross-module atomicity caveat (~line 120)
difficulty: medium
----

# Clean-shutdown marker durability (synced consume-delete)

The MV adopt fast path's clean-shutdown marker is single-use: `rehydrateCatalog`
reads it then deletes it at open (`consumeCleanShutdownMarker`,
`store-module.ts` ~2151). The delete is a plain unsynced `catalogStore.delete`,
and it lands in a **different KV store** from the session's subsequent data
writes, with independent (unsynced) flushing. A power loss can persist
mid-session data writes while losing the marker delete; the next open then finds
a resurrected marker, attests a "clean shutdown" that never happened, and adopts
a backing across a genuine crash window — and it never self-heals (each clean
close re-arms the marker). Process kills are safe (OS-buffered writes survive);
only power loss is exposed.

**Invariant to restore:** the marker-consume delete must be durable before any
of the session's data writes can become durable.

This is the lesser, self-contained fix called out in the parent plan
(`store-atomic-multi-store-commit`). It is independent of the atomic-batch
capability work and closes a real correctness window now. The close-side marker
*write* may stay unsynced (losing it is conservative — the next open refills).

## Design

Add an optional, backend-honored durability hint to the `KVStore` point-write
surface and use it for the marker-consume delete only.

```ts
// kv-store.ts
/** Per-write durability hint. */
export interface WriteOptions {
	/**
	 * Flush this write to stable storage before resolving. Default false.
	 * Backends without a durability knob (in-memory) ignore it; IndexedDB is
	 * already durable at transaction oncomplete.
	 */
	sync?: boolean;
}

export interface KVStore {
	// ...
	put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void>;
	delete(key: Uint8Array, options?: WriteOptions): Promise<void>;
	// ...
}
```

`options` is optional, so every existing call site is unaffected. The
`WriteBatch` surface is **not** touched — only the marker consume needs this,
and it is a single point delete per open.

Backend behavior:

- **LevelDB** (`store.ts`): `this.db.put(key, value, { sync: options?.sync })`
  and `this.db.del(key, { sync: options?.sync })`. classic-level forwards
  `sync` to the underlying write.
- **IndexedDB** (`store.ts`): an IDB write is durable when its transaction
  fires `oncomplete`, which `put`/`delete` already await. When `sync` is
  requested, create the transaction with `{ durability: 'strict' }`
  (`db.transaction(name, 'readwrite', { durability: 'strict' })`) where
  supported; otherwise the existing await is sufficient. Do not regress the
  default (unspecified durability) path.
- **InMemoryKVStore** (`memory-store.ts`): ignore `options` (no-op).

Then in `consumeCleanShutdownMarker` (`store-module.ts` ~2151):

```ts
await catalogStore.delete(markerKey, { sync: true }); // single-use AND durable-before-session-writes
```

Update the caveat in `docs/materialized-views.md` § Cross-module atomicity
(the "Marker durability under power loss" bullet, ~line 120, and the trailing
sentence of the gate-5 paragraph ~line 116): the synced consume-delete closes
the power-loss window; note the remaining position that a provider-level atomic
multi-store commit domain would subsume even this (tracked in backlog
`store-module-wide-atomic-commit`).

## Edge cases & interactions

- **Optionality / no signature breakage.** `options` must be the trailing
  optional arg on `put`/`delete`; all current callers (the whole store package,
  isolation, sync, every provider) pass two args and must keep compiling. Run
  `yarn lint` in `packages/quereus` (it type-checks call sites).
- **Backend without a sync knob.** Memory and any future backend must silently
  no-op on `sync: true`, never throw — losing durability is acceptable there
  (memory has no crash; a backend that can't sync is documented best-effort).
- **IDB `durability: 'strict'` availability.** Older engines may not accept the
  options bag; pass it defensively (feature-detect or wrap so an unsupported
  option does not break the default path). The fallback (plain `oncomplete`
  await) is already correct for IDB — `sync` is belt-and-suspenders there.
- **Marker absence / crash.** A missing marker still returns
  `{ trusted: false }` (refill everything) — unchanged. The synced delete only
  matters when a marker WAS present.
- **Single-use ordering preserved.** The delete still happens before the
  catalog scan and is still unconditional regardless of payload parse outcome.
- **Close-side write stays unsynced.** Confirm `closeAll`'s marker *write* is
  left as-is; only the open-side consume-delete gains `sync: true`.
- **CachedKVStore passthrough.** The catalog store is not cache-wrapped in
  LevelDB; in IndexedDB the catalog store is opened raw (`getCatalogStore`
  returns an `IndexedDBStore`, not a `CachedKVStore`), so the `sync` option
  reaches the real store. Verify the wrapper (`cached-kv-store.ts`) forwards
  `options` on `put`/`delete` anyway, so the hint is not silently dropped if a
  cached store is ever marker-bearing.

## TODO

- Add `WriteOptions` to `kv-store.ts` and thread the optional arg through the
  `KVStore.put`/`delete` signatures.
- Implement `sync` in LevelDB `store.ts` (`{ sync }` to `put`/`del`).
- Implement `sync` in IndexedDB `store.ts` (`durability: 'strict'`, defensively).
- No-op `options` in `InMemoryKVStore` and forward `options` in `CachedKVStore`.
- Use `delete(markerKey, { sync: true })` in `consumeCleanShutdownMarker`.
- Update `docs/materialized-views.md` § Cross-module atomicity caveat.
- Tests: a `KVStore` unit test asserting `put`/`delete` accept and ignore/honor
  `options` per backend (memory no-op; LevelDB forwards without error); a store
  test asserting `consumeCleanShutdownMarker` still deletes the marker exactly
  once and returns the right `{ trusted, staleAtClose }` with the new arg.
- `yarn test` (memory) and, if touching the LevelDB path meaningfully,
  `yarn test:store`; `yarn lint` in `packages/quereus`.
