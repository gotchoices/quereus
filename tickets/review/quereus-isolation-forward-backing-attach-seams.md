----
description: Forward the three durable-backing attach seams through IsolationModule so wrapped hosts can use maintained/derived tables.
files:
  - packages/quereus-isolation/src/isolation-module.ts
----

## Summary

Added three property declarations and constructor forwards in `IsolationModule` for the attach-lifecycle seams that were previously missing:

- `ensureBackingForAttach` — called by the engine before resolving the backing host on a `set maintained` attach
- `retireBackingForAttach` — called on `drop maintained` to migrate rows back into ordinary storage
- `discardBackingForAttach` — called on failed fresh attach to drop the just-created (empty) backing store

Each follows the exact presence-mirroring pattern already used by `getBackingHost` and `createBacking`: the property is assigned on `this` only when `this.underlying.<seam>` is a function, so the wrapper advertises the capability iff the underlying does. Each is a straight delegate — no overlay bookkeeping, consistent with the `getBackingHost` rationale (backing writes are privileged and bypass the per-connection overlay).

## Change location

`packages/quereus-isolation/src/isolation-module.ts` — three property declarations added after `createBacking?` (lines ~193), three constructor blocks added after the `underlyingCreateBacking` block (~lines 206–214).

## Test results

- `@quereus/isolation` conformance suite: **128 passing**
- Full workspace `yarn test`: **all suites passing**

## Use cases for reviewer validation

1. **`set maintained` through the wrap** — a table registered with `new IsolationModule({ underlying: laminaModule })` should successfully become a maintained/derived table; previously failed with `backing host not found`.
2. **`drop maintained` through the wrap** — the retire seam reaches the underlying so rows migrate back into ordinary storage.
3. **Failed fresh attach cleanup** — if a `set maintained` fails after `ensureBackingForAttach` runs (e.g. CHECK violation), `discardBackingForAttach` reaches the underlying to drop the partially-created store.
4. **Re-attach across a second transition** — drop maintained → set maintained again must work; the underlying's `ensureBackingForAttach` is idempotent by spec.
5. **Non-backing-host module unchanged** — a wrapper around a module that does not implement these seams must not advertise them (presence-mirroring guard).

## Known gaps

The downstream integration tests (six capability-gated tests in the lamina repo's `maintained-isolation-wrap-lifecycle.test.ts`) cannot run here. They activate once the `wrapForwardsBackingAttachSeams()` probe flips true against the portal-linked checkout. The in-repo conformance suite has no spy exercising the full maintained lifecycle through an `IsolationModule` wrap (the existing `materialized-view-discard-backing.spec.ts` spy hits the seams directly on a plain `MemoryTableModule`, not through the isolation wrapper). A reviewer who wants in-repo coverage of the wrap path could add a test analogous to that spec but registering `new IsolationModule({ underlying: spy })`.
