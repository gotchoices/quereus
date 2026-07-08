description: The engine's lock queue is a single process-wide table keyed only by a string, so two independent databases that happen to use the same key fight over the same lock. Scope the lock registry to each database instead.
files:
  - packages/quereus/src/util/latches.ts (the process-global static Map to scope)
  - packages/quereus/src/vtab/memory/layer/manager.ts (all Latches.acquire call sites — commit/collapse/consolidate/destroy/schema-change)
  - packages/quereus/src/index.ts (public `export { Latches }`)
difficulty: medium
----

## Problem

`util/latches.ts` holds its lock queues in a `static` `Map<string, Promise<void>>`
shared across **all** `Database` instances, keyed only by a string. Two independent
databases that pass the same key string contend on the same latch — a correctness /
isolation smell even though today every caller namespaces its key with
`schema.table`, which keeps real collisions to genuinely same-named tables in the
same process.

This was one bullet of `5-core-smaller-cleanups`. The **diagnostics half** already
landed there: `Latches.acquire(key, timeoutMs?)` now supports an opt-in
timeout/deadlock warning that releases its queue slot and rejects on expiry. This
ticket is the **scoping half**, split out because it is the larger, non-trivial
change (public export + many `Latches.acquire(...)` static call sites).

## Requirements

- **Scope the latch registry to an owner** — a `Database` (or a smaller owner if
  that fits better), so two databases never share a queue for the same key. Prefer
  an owned `Latches` *instance* (per-database field) over the process-global
  `static` Map.
- Update every call site. The known ones are in
  `vtab/memory/layer/manager.ts`: `Commit`, `Collapse`, `Consolidate`, `Destroy`,
  and the `SchemaChange` operations (add/drop/rename column, create/drop index,
  add/drop/rename constraint, alter column, replaceBaseLayer). Each has `this.db`
  available, so threading a per-database latch instance is feasible.
- Keep the public `export { Latches }` working (external store modules may use it).
  If the shape changes from static-only to instance-based, decide and document
  whether the public export stays a class with a default/global instance for
  standalone use, or becomes owner-scoped — do not silently break the export.
- Preserve the timeout/diagnostics behavior already added (`timeoutMs`, the
  slot-release-on-timeout, the BUSY rejection, the warning log).

## Expected behavior

- Two `Database` instances that both lock `MemoryTable.Commit:main.t` proceed
  independently (no cross-database serialization).
- Within one database, same-key acquires still serialize exactly as before.
- The existing `Promise.race` opt-out timeout pattern in `manager.ts`
  (`tryCollapseLayers`) keeps working.

## Validation

- `yarn workspace @quereus/quereus run build` / `lint`
- `yarn test` and, because the latches guard transaction/commit/schema-change
  serialization on the store path, `yarn test:store` is worth running for this one.
- Consider a focused test: two databases contending on an identically-named table
  do not block each other; one database still serializes same-key work.

## Note

The `util/latches.ts` module NOTE comment already points here by this exact slug
(`latches-database-scoping`) — update/remove it when this lands.
