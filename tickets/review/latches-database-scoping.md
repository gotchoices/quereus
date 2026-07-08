description: The engine's lock queue was a single process-wide table so two independent databases sharing a key string fought over one lock; it is now scoped per-database, and this ticket asks a reviewer to confirm the scoping and its backward-compatible fallback are correct.
files:
  - packages/quereus/src/util/latches.ts (Latches: static-only → instance-based + static delegation to a global default)
  - packages/quereus/src/core/database.ts (new `public readonly latches = new Latches()` field + import)
  - packages/quereus/src/vtab/memory/layer/manager.ts (14 call sites: `Latches.acquire` → `this.db.latches.acquire`; import removed)
  - packages/quereus/test/util/latches.spec.ts (new `instance scoping` describe block, 2 tests)
difficulty: medium
----

## What landed

`util/latches.ts` held its lock queues in a `static Map<string, Promise<void>>`
shared across **all** `Database` instances. Two independent databases passing the
same key contended on the same latch (an isolation smell; today masked because
every caller namespaces its key with `schema.table`). This ticket scoped the
registry per-database.

### The change, concretely

- **`Latches` is now instance-based.** `lockQueues` is a `private readonly`
  instance field (one map per instance) and `acquire(key, timeoutMs?)` is an
  instance method. The timeout/deadlock-guard behavior (slot-release-on-timeout,
  BUSY rejection, warning log) is unchanged — same body, `this.lockQueues`.
- **The static `Latches.acquire` was kept** as a thin delegate to a single
  process-global default instance (`private static readonly global = new Latches()`).
  This preserves the original shared-queue entry point for standalone callers
  (external store modules) that hold no `Database`, and keeps the public
  `export { Latches }` in `index.ts` working unchanged. (Static + instance method
  of the same name coexist — different objects: constructor vs. prototype.)
- **`Database` owns one instance:** `public readonly latches = new Latches()`.
- **All 14 memory-manager call sites** in `vtab/memory/layer/manager.ts` now call
  `this.db.latches.acquire(lockKey)` instead of `Latches.acquire(lockKey)`
  (Commit, Collapse — including the `Promise.race` opt-out timeout in
  `tryCollapseLayers` — Consolidate, Destroy, and the 10 SchemaChange ops). The
  `import { Latches }` line was removed from manager.ts since it's no longer
  referenced there. Lock-key strings are byte-for-byte identical.
- The old NOTE in `latches.ts` that pointed at this ticket slug is gone; the
  docstring now describes the instance/global split.

## Why it's correct (reviewer: verify these claims)

- **Two databases no longer contend.** Each `Database` has its own `Latches`
  instance → its own `lockQueues` map. Same key string in two databases → two
  independent queues. Directly tested (see below).
- **Within one database, same-key still serializes** exactly as before — same
  map, same tail-chaining logic. Also tested.
- **The static fallback preserves old global semantics** for any external caller
  still using `Latches.acquire(...)` — they share the one `global` instance,
  identical to the previous static map. No in-repo package uses the static export
  (grep of `packages/` outside `quereus/` found none), so the fallback exists
  purely for external store modules named in the ticket.

## Use cases / testing done

- **New unit tests** (`test/util/latches.spec.ts` → `describe('instance scoping')`):
  - *two instances do NOT contend on the same key* — instance `a` holds
    `MemoryTable.Commit:main.t` and never releases; instance `b` acquiring the
    same key resolves anyway (models two databases locking an identically-named
    table).
  - *a single instance still serializes same-key acquires* — order-of-execution
    assertion, mirrors the pre-existing static serialize test.
- Ran `node packages/quereus/test-runner.mjs --grep "Latches"` → 5 passing
  (3 pre-existing + 2 new).

## Validation run

- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + tsc on test files)
- `yarn test` → all packages green; quereus 6481 passing, exit 0.
  (Log shows *injected* errors from other suites — `boom`, `THIS IS NOT VALID
  SQL`, `bookkeeping-bug` — these are intentional negative-path tests in
  quereus-store, not failures; that suite still reports 675 passing.)
- `yarn test:store` (ticket-recommended, LevelDB store path that exercises
  commit/schema-change serialization) → 6476 passing, 14 pending, exit 0.

## Known gaps / reviewer starting points (not a finish line)

- **The tests validate `Latches` at the instance level, not end-to-end through
  two live `Database` objects hammering a same-named table concurrently.** The
  unit test is a faithful model (same key, two instances) but a reviewer wanting
  belt-and-suspenders could add an integration test: two `new Database()`, each
  `create table t (...)`, concurrent writes, assert no cross-DB serialization
  stall. Considered lower-value than the direct instance test, so deferred.
- **The static `global` instance is process-lifetime and never cleared.** That's
  identical to the prior static map (also never cleared beyond per-key cleanup on
  release), so no regression — but if a reviewer feels the retained static
  surface is dead weight (no in-repo caller), removing it and making the export
  instance-only is a defensible alternative. Kept per the ticket's explicit
  "do not silently break the export" requirement.
- **No new latch is introduced and no lock-key string changed**, so ordering /
  deadlock characteristics are unchanged from HEAD — the change is purely *where*
  the registry lives. Worth a reviewer's eye that all 14 call sites were
  converted (grep `Latches.acquire` in `src/` should return only the static
  definition/delegate in `latches.ts`, zero call sites).
