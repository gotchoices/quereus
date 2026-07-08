description: When one transaction changes rows in several tables and something fails partway through saving, some tables end up permanently saved while others are lost, leaving the data half-applied. Fix the isolation layer's commit so all the tables save together or none do.
prereq:
files:
  - packages/quereus-isolation/src/isolated-table.ts        # flushOverlayToUnderlying (~1394), flushAndClearOverlay (~1372), commit (~1363), onConnectionCommit (~1607)
  - packages/quereus-isolation/src/isolated-connection.ts   # IsolatedConnection.commit (~49); onConnectionCommit callback wiring
  - packages/quereus-isolation/src/isolation-module.ts      # connectionOverlays map, getUnderlyingState, clearConnectionOverlay, clearPreOverlaySavepoints — home for the new commit coordination
  - packages/quereus-store/src/common/store-table.ts        # begin/commit/rollback idempotent seam (~1825) — the model this fix must drive correctly
  - packages/quereus-store/README.md                        # § Atomic multi-store commit (module-wide, cross-table) — the behavior the isolation layer must inherit rather than defeat
  - docs/design-isolation-layer.md                          # § Commit (~229), § Commit Failure Recovery (~517) — update
  - packages/quereus-isolation/test/isolation-layer.spec.ts # existing test infra + Proxy-wrap fault-injection pattern (~2415)
difficulty: hard
----

# Fix: torn multi-table commit in the isolation layer

## Root cause (confirmed, with a reproduced failure)

When an isolated transaction has written to more than one table, each table flushes
its overlay to the underlying store in its **own independent** underlying
transaction at commit time. If table A flushes+commits successfully and then table
B's flush fails, A's changes are already durably committed while B's roll back — the
transaction is torn.

The mechanics, traced end-to-end:

1. The database drives commit as a **sequential** loop over registered connections
   (`database-transaction.ts` `commitTransaction`, ~line 271:
   `for (const connection of connectionsToCommit) await connection.commit()`).
   The isolation layer registers **one covering `IsolatedConnection` per table**
   (`isolated-table.ts` `buildConnection`), so a 2-table transaction has 2
   connections in that loop.
2. Each `IsolatedConnection.commit()` calls `onConnectionCommit()` →
   `flushAndClearOverlay()` → `flushOverlayToUnderlying()`
   (`isolated-table.ts` ~1394). That method does, **per table**:
   `underlyingTable.begin()` → apply the overlay's rows → `underlyingTable.commit()`.
3. For a `quereus-store` underlying, `StoreTable.begin/commit/rollback`
   (`store-table.ts` ~1825) forward to the module's **single shared
   `TransactionCoordinator`**. `begin()` is idempotent; `commit()` writes **all**
   pending ops across **all** tables and clears; `rollback()` discards all.

So table A's per-table `underlyingTable.commit()` flushes+clears the shared
coordinator **before table B has even applied its overlay**. A is now durable; B
then begins a fresh coordinator transaction, applies, and if it fails, only B rolls
back. Torn.

The irony: the `quereus-store` module was **designed** to make multi-table commits
all-or-nothing (see `quereus-store/README.md` § "Atomic multi-store commit
(module-wide, cross-table)"): one shared coordinator, sequential connection commits,
idempotent `commit()`/`rollback()`, so "the first connection to commit flushes every
touched store of every table; the remaining connections no-op." The `StoreTable`
`begin()` doc even names the culprit: it exists "for the isolation layer's flush
path, which treats the underlying write as an **independent mini-transaction**." That
per-table independence is exactly what defeats the coordinator's cross-table
atomicity. The prerequisite `2-store-atomic-batch-capability` (complete) further makes
the coordinator's single `commit()` a single durable atomic batch on providers that
expose `beginAtomicBatch` (IndexedDB, LevelDB) — but the isolation layer never lets
that single `commit()` happen for a multi-table transaction.

### Reproduced

A scratch test (memory underlying, a Proxy-wrapped module that throws on table `b`'s
flush `update` when `trustedWrite` is set) confirmed the defect:

```
BEGIN; INSERT INTO a VALUES (1,'a1'); INSERT INTO b VALUES (1,'b1');
-- arm failure on table b, then COMMIT (throws)
-- AFTER-FAILED-COMMIT  a = [{"id":1,"v":"a1"}]   b = []
```

Table A durably committed even though B's flush failed and COMMIT surfaced the error.
Expected: both empty (atomic abort). The fault-injection pattern to reuse is the
`Proxy`-over-`MemoryTable` wrapper already in `isolation-layer.spec.ts` (~line 2415,
`wrapUnderlying`) — wrap `update` instead of `query`, and fail only when
`args.trustedWrite` is set (that flag marks the commit-flush path, not user DML).

### Distinct from the documented out-of-scope concern

This is **not** the cross-connection "no write-write conflict detection / last writer
wins" item in `design-isolation-layer.md` (~line 140), which is about two *different*
connections racing on the same row and is deliberately out of scope. This ticket is a
straight **atomicity** defect **within a single connection's own commit** spanning
multiple tables. Keep the two separate in any doc edits.

## The fix: apply-all-then-commit-once, coordinated across the transaction's overlays

Restructure the isolation commit so the whole transaction's overlays flush in **two
phases** driven **once** per db-transaction, instead of begin→apply→commit per table:

- **Phase 1 (apply).** For every overlay this db-transaction staged (with changes),
  `begin()` its underlying table and apply the overlay's rows (the existing
  tombstone-ordering, insert-vs-update, `trustedWrite`, and `assertFlushWriteOk`
  logic) — **without committing**.
- **Phase 2 (commit).** Once **all** overlays have applied, `commit()` the affected
  underlying tables.
- **On any Phase-1 error:** `rollback()` the affected underlying tables and propagate.
  Nothing was committed, so the transaction aborts atomically.

Why this is correct for each underlying:

- **`quereus-store` (shared coordinator).** Phase 1's `begin()` on table A opens the
  coordinator; table B's `begin()` is an idempotent no-op; both tables' ops accumulate
  in the one coordinator. Phase 2's first `commit()` writes **all** of them in a single
  coordinator `commit()` — one atomic `AtomicBatch.write()` on IndexedDB/LevelDB —
  and the rest no-op. A Phase-1 failure's `rollback()` discards **all** pending ops.
  True cross-table atomicity, inherited from the store's existing design.
- **Memory / any underlying with per-table transaction domains.** Phase 2 commits each
  table independently, so a failure *during the commit phase itself* can still tear.
  But all the **fallible data work** (constraint re-checks surfaced via
  `assertFlushWriteOk`, injected/IO errors during `update`) happens in Phase 1, before
  any commit — so a data-driven abort is clean and atomic. Only an infrastructure
  failure during the near-infallible commit-phase (memory layer promotion) can tear,
  which the isolation layer cannot prevent without an atomic underlying. This is the
  documented **fail-safe** contract: full crash-atomicity is contingent on the
  underlying exposing a shared atomic commit domain.

### Where the coordination lives

The single-pass flush needs access to **all** of the db-transaction's overlays and
their underlying tables at once. `IsolationModule` already holds both:
`connectionOverlays` (keyed `<dbId>:<schema>.<table>` → `ConnectionOverlayState` with
`overlayTable` + `hasChanges` + `poison`) and `underlyingTables` (→ `underlyingTable`).
So `IsolationModule` is the natural coordinator.

Suggested shape (implementer's discretion on exact structuring):

- Add an `IsolationModule` method, e.g. `commitConnectionOverlays(db)`, that gathers
  every `connectionOverlays` entry for that `dbId`, runs the two-phase flush across
  them, then clears each overlay and its pre-overlay-savepoint set.
- `IsolatedTable.onConnectionCommit()` delegates to it. The **first** connection's
  commit performs the whole coordinated flush and clears **all** the db's overlays;
  subsequent connections in the DB loop then find their overlay already cleared
  (`hasChanges === false` / no overlay) and no-op naturally — **no explicit latch
  needed**, the cleared-overlay state is self-guarding. Verify this holds (see TODO).
- The per-table apply logic currently in `flushOverlayToUnderlying` should be split
  into an **apply-only** step (begin + apply, no commit) reusable by the coordinator.
  Because `connectionOverlays` does not hold `IsolatedTable` instances (they are
  created fresh per statement) and the apply logic only needs
  `underlyingTable` + `overlayTable` + `underlyingTable.tableSchema` + the tombstone
  column, extract it into a standalone helper (a function, or a static/util) that the
  module calls per (underlyingTable, overlayTable). Keep `assertFlushWriteOk`'s
  loud-INTERNAL-on-constraint behavior and the deletes-before-inserts ordering intact.

### Fallback contract (document, don't over-engineer)

The fix's behavior is uniform ("apply all, then commit all") regardless of underlying.
Do **not** add a capability-negotiation flag or a distributed 2PC. Just document, in
`design-isolation-layer.md` § "Commit Failure Recovery", the honest contract:

- Multi-table commits are atomic when the underlying module commits its tables through
  a shared atomic commit domain (the `quereus-store` module-wide coordinator +
  a provider with `beginAtomicBatch`).
- For underlyings with per-table domains (the default memory vtab), the isolation
  layer guarantees only that a **data-driven** failure aborts cleanly (nothing
  committed), because all fallible work precedes any commit; a bare infra failure
  during the commit phase can still leave earlier tables committed. Full
  crash-atomicity is contingent on the underlying's capability.

## TODO

Phase — reproduce & scaffold
- [ ] Add a failing test to `packages/quereus-isolation/test/isolation-layer.spec.ts`
      (or a new `torn-commit.spec.ts`): two tables, second table's flush fails
      (Proxy-wrap the underlying `update` to throw when `args.trustedWrite` is set),
      assert **both** tables are empty after the failed COMMIT. Reuse the `wrapUnderlying`
      Proxy pattern at ~line 2415. This is the reproduced repro above — start red.

Phase — restructure commit
- [ ] Split `flushOverlayToUnderlying` (`isolated-table.ts` ~1394) into an apply-only
      step (begin + apply overlay rows, **no** `underlyingTable.commit()`) and factor
      it so `IsolationModule` can invoke it per (underlyingTable, overlayTable).
      Preserve: deletes-first ordering, `preCoerced`/`trustedWrite`, and
      `assertFlushWriteOk` (loud INTERNAL on a post-precheck constraint).
- [ ] Add `IsolationModule.commitConnectionOverlays(db)` implementing the two-phase
      flush across all of the db's overlays: Phase 1 apply-all; Phase 2 commit-all;
      rollback-all + rethrow on any Phase-1 error. Then clear each overlay
      (`clearConnectionOverlay`) and its pre-overlay savepoints
      (`clearPreOverlaySavepoints`).
- [ ] Rewire `IsolatedTable.onConnectionCommit()` (~1607) and `flushAndClearOverlay`
      (~1372) to delegate to the module coordinator instead of flushing only their own
      table. Confirm subsequent connections in the DB commit loop no-op because their
      overlay is already cleared (no explicit latch). If self-guarding proves fragile
      (e.g. ordering with `overlayConnection.commit()` in `IsolatedConnection.commit()`),
      add a minimal per-db "already flushed this commit" guard on the module, reset when
      overlays are next staged.
- [ ] Preserve poison semantics: if **any** overlay in the set is poisoned
      (cross-connection ALTER; `ConnectionOverlayState.poison`), the coordinated flush
      must throw and abort the whole commit (it does today per-connection via
      `assertOverlayUsable`) — now with the added benefit that no earlier table is left
      committed. Verify `assertOverlayUsable` still fires in the new path.

Phase — validate
- [ ] The new torn-commit test goes green (both tables empty after failed COMMIT).
- [ ] Add a positive multi-table test: BEGIN; write to A and B; COMMIT; both durably
      present — proving the happy path still commits everything.
- [ ] `yarn workspace @quereus/quereus-isolation run test` green (stream with `tee`).
- [ ] `yarn workspace @quereus/quereus run typecheck` and `yarn lint` clean.
- [ ] Consider running `yarn test:store` (LevelDB, exposes `beginAtomicBatch`) if
      agent-runnable to exercise the true-atomic path end-to-end; if too slow, defer to
      CI/human and document the deferral (LevelDB `beginAtomicBatch` gives real
      cross-table atomicity — worth a targeted assertion à la the IndexedDB
      `atomic-dml.spec.ts` single-transaction spy, but that lives in the plugin package,
      not isolation).

Phase — docs
- [ ] Update `docs/design-isolation-layer.md` § "Commit" (~229) — the flush is now a
      transaction-wide two-phase apply-all-then-commit-once, not per-table
      begin/commit — and § "Commit Failure Recovery" (~517) — replace the per-table
      atomicity claim with the multi-table contract above (atomic on a shared atomic
      commit domain; data-driven-clean-abort otherwise). Do not conflate with the
      out-of-scope cross-connection write-write item (~140).

## Watch out for

- **One IsolationModule wraps one underlying module.** All the transaction's tables
  share that module (and, for store, its one coordinator). Don't design for a mix of
  underlying modules within a single isolated transaction — that isn't a supported
  topology.
- **Single-table / autocommit path must be unchanged in outcome.** The degenerate case
  (one overlay) is apply-then-commit of one table — identical to today. Verify implicit
  (autocommit) single-statement transactions still work.
- **Rollback path is unchanged** — overlays are discarded, the underlying is never
  committed. Only the commit path changes.
- **Events / change tracking** are recorded during the transaction by the DML executor;
  the flush is persistence only. Don't alter event semantics — the store coordinator's
  single `commit()` already fires the buffered events once.
