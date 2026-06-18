description: Some materialized-view engine changes were committed by accident under an unrelated storage-plugin ticket and never got their own review or tests — give them a proper look and add coverage.
files:
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/vtab/module.ts
----

# Follow-up: review the MV attach/discard engine changes that landed under the LevelDB ticket

## Why this exists

The implement commit for `store-leveldb-shared-root` (`45619c26`) also committed four
engine materialized-view files that have nothing to do with the LevelDB storage
backend. The implement handoff described these as edits from a "concurrent process"
that were present in the working tree at commit time. They compile, pass lint, and
pass the memory + store test suites, so they were left in place during the LevelDB
review — but they never went through their own plan → implement → review cycle, and
one of them is a live behavior change while the other is currently dead code. This
ticket is to give them a proper, focused review and add the missing in-repo coverage.

## What changed (to review)

1. **`tryResolveBackingHost` (live behavior change).**
   `materialized-view-helpers.ts` adds a *lenient* counterpart to `resolveBackingHost`
   that returns `undefined` instead of throwing when the owning module cannot yet
   resolve a backing host. `database-materialized-views.ts` switches the
   maintenance-plan-build replicable-derivation gate from `this.backingHost(mv)`
   (throws if absent) to `tryResolveBackingHost(db, mv)` (skips the gate if absent).
   The inline rationale: a module that materializes its durable backing *late* in the
   attach flow (lamina's `ensureBackingForAttach`, after gate registration) has no host
   at plan-build time, and a host that sets `requiresReplicableDerivations` (the
   synced-store flavor) always exists by then, so skipping when absent never lets a
   non-replicable body slip past.
   - **Review focus:** confirm that argument holds — that no real configuration both
     (a) lacks a host at plan-build time and (b) needs the replicable gate to fire. Add
     a regression test that would fail if the gate were silently skipped for a case that
     must reject (non-replicable FUNCTION / COLLATION) under a late-materializing host.

2. **`discardBackingForAttach` (currently dead in-repo).**
   `vtab/module.ts` adds an optional `VirtualTableModule.discardBackingForAttach(db,
   schemaName, tableName)`; `materialized-view-helpers.ts`'s `attachMaintainedDerivation`
   gains a `discardBackingOnFailure` flag (set by `runSetMaintained` in
   `alter-table.ts`) that, on a FAILED FRESH attach (not a re-attach, reconcile not
   committed), calls `module.discardBackingForAttach?.(...)` to drop a backing store
   freshly created by `ensureBackingForAttach`. **No module in this repo implements
   `discardBackingForAttach`**, so the call is a no-op everywhere here; the real
   implementor is a downstream module (lamina).
   - **Review focus:** decide whether this seam belongs in the engine now (forward
     infra for a downstream module) or should be gated behind that module's own ticket.
     If it stays, add an in-repo test module that implements `discardBackingForAttach`
     and assert the fresh-attach-failure path actually invokes it (and that a re-attach
     / reconcile-committed path does NOT), so the careful `!reconcileCommitted &&
     !priorMaintained` condition is covered rather than dead.

## Notes

- Do **not** treat this as a revert: the changes are functional and the LevelDB review
  validated that they do not break existing suites. The goal is independent review +
  test coverage, and correct attribution going forward.
- The `51.7-maintained-table-attach-detach` failure that surfaced alongside this work was
  a *separate* issue, already fixed by triage commit `e367380d` in
  `quereus-store/src/common/store-module.ts` (stale `StoreTable` schema cache on
  `materialized_view_removed`). That fix is unrelated to the two items above.
