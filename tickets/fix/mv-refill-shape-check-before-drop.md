description: The MV rehydrate refill path drops a durable store backing before confirming the body can rebuild — an unmaterializable body (arity/shape mismatch) loses the durable rows. Assert the backing shape before the drop so an unrebuildable entry is preserved as a plain table instead.
prereq: maintained-table-attach-detach-verbs
files:
  - packages/quereus-store/src/common/store-module.ts          # rehydrateCatalog phase 3 (refill vs adopt path)
  - packages/quereus/src/schema/manager.ts                     # importCatalog / materializeView refill: drop-then-rebuild ordering
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # tryAdoptPreExistingBacking arity check (the adopt-path precedent)
  - docs/materialized-views.md                                 # § Cross-module atomicity (refill vs adopt drop ordering)
difficulty: medium
----

## Problem

On catalog rehydrate, an MV entry that is **not** trusted (a crash, or — since
`mv-adopt-stale-at-close` — a stale-at-close MV) takes the **refill** path:
drop the pre-existing `_mv_<name>` backing, then re-run the body to rebuild it.
The drop happens **before** the body is checked for materializability.

When the body can no longer materialize — e.g. a `select *` body whose source
was widened across sessions now produces more columns than the MV's explicit
declared column list (`mv(a, b)`) — the refill path drops the durable backing
and *then* fails the arity check, so the durable rows are lost and the entry
errors per-entry with no MV registered.

The **adopt** path already does the right thing: `tryAdoptPreExistingBacking`
runs its arity/shape check **before** any drop, so an unmaterializable body
leaves the backing preserved as a plain table for a later DDL fix. The refill
path should mirror that ordering.

## Why it matters / scope

- Discovered during review of `mv-adopt-stale-at-close`. That fix routes
  stale-at-close MVs through refill, which makes this pre-existing refill
  property newly reachable for a stale MV with a broken body (previously such a
  backing was silently — and unsoundly — *adopted*; that was the bug being
  fixed, so the net change is "lose the already-stale rows" rather than "serve
  stale rows", judged acceptable at the time).
- The data-loss-on-unrebuildable-body property is **not** specific to staleness:
  any crash-driven refill of an MV whose body can't rebuild has the same
  outcome. Fixing it in the refill path helps both cases.

## Expected behavior

A refill whose body provably cannot materialize (declared-column arity mismatch,
or a structural backing-shape mismatch the body can't satisfy) should **preserve
the existing durable backing as a plain table** and record a per-entry error —
identical to the adopt path's preserve-on-unmaterializable branch — rather than
dropping the durable rows first. Only proceed with the destructive drop+rebuild
once the body is confirmed materializable into the derived shape.

## Notes

- Tracked sibling caveats: `mv-adopt-marker-sync-durability` (marker durability)
  and `store-atomic-multi-store-commit` (the gate this whole area exists for).
- The pathological trigger requires a cross-session source-shape change under an
  explicit MV column list; it is rare, but it is silent durable data loss when it
  fires, which is why it is worth closing rather than leaving as a documented
  corner.
