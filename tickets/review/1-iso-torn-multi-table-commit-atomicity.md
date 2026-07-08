description: Verify the isolation layer's fix that makes a multi-table transaction commit all its tables together or none, so a failure partway through can no longer leave data half-saved.
prereq:
files:
  - packages/quereus-isolation/src/isolation-module.ts        # NEW commitConnectionOverlays(db) two-phase coordinator (~after clearPreOverlaySavepoints); removed private makeFullScanFilterInfo
  - packages/quereus-isolation/src/flush.ts                    # NEW — applyOverlayToUnderlying (apply-only) + assertFlushWriteOk
  - packages/quereus-isolation/src/filter-info.ts             # NEW — shared makeFullScanFilterInfo / makePkPointLookupFilter
  - packages/quereus-isolation/src/isolated-table.ts          # commit()/onConnectionCommit() now delegate to coordinator; removed flushOverlayToUnderlying/flushAndClearOverlay/assertFlushWriteOk/rowExistsInUnderlying; two filter builders delegate to shared util
  - packages/quereus-isolation/src/isolated-connection.ts     # unchanged, but read: commit() calls onConnectionCommit() then overlay/underlying connection commit
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # NEW describe "atomic multi-table commit (torn-commit fix)" (~end of file)
  - docs/design-isolation-layer.md                            # § Commit and § Commit Failure Recovery rewritten
difficulty: medium
----

# Review: torn multi-table commit in the isolation layer (fixed)

## What was wrong (one paragraph, plain)

When one isolated transaction wrote to more than one table, each table flushed **and
committed** its own underlying store independently at commit time. Table A committed
durably before table B had even applied its changes, so if B then failed, A stayed
committed while B rolled back — the transaction was torn (half-applied). For a
`quereus-store` underlying the damage was worse: A's per-table commit flushed the
module's single shared coordinator, committing *every* pending table, defeating the
store's own cross-table atomicity design.

## The fix

Commit is now a **transaction-wide, two-phase flush driven once**, not per table:

- New `IsolationModule.commitConnectionOverlays(db)` gathers every overlay the
  db-transaction staged and runs: **Phase 1** — `begin()` each underlying and apply its
  overlay rows *without committing*; **Phase 2** — once all have applied, `commit()` the
  affected underlyings. On any Phase-1 error it rolls back every begun underlying and
  rethrows (atomic abort). A poisoned overlay (cross-connection ALTER) aborts the whole
  commit before any apply.
- `IsolatedTable.onConnectionCommit()` and the table-level `commit()` now **delegate** to
  that coordinator. The first connection in the database's sequential commit loop performs
  the whole flush and clears all overlays; later connections find their overlay already
  cleared and no-op (no explicit latch — cleared-overlay state self-guards).
- The per-table apply logic was extracted to `flush.ts` `applyOverlayToUnderlying`
  (apply-only: begin + apply, no commit), preserving deletes-before-inserts ordering,
  `preCoerced`/`trustedWrite`, and the loud-INTERNAL `assertFlushWriteOk` on a
  post-precheck constraint. Two duplicated `FilterInfo` builders were consolidated into
  `filter-info.ts` (shared by the table, the module's ALTER/DROP-INDEX migrations, and the
  flush).

Why it's correct per underlying:
- **`quereus-store` (shared coordinator):** Phase 1's begins/applies all accumulate in the
  one coordinator; Phase 2's first `commit()` writes everything in a single atomic
  coordinator commit (one `AtomicBatch.write()` on IndexedDB/LevelDB) and the rest no-op. A
  Phase-1 rollback discards all pending ops. True cross-table atomicity.
- **Memory / per-table domains:** all *fallible data work* happens in Phase 1 before any
  commit, so a data-driven abort is clean. Only a bare infra failure *during the commit
  phase itself* can still tear — the documented fail-safe contract (full crash-atomicity is
  contingent on the underlying exposing a shared atomic commit domain).

## How to validate

Run the isolation suite (fast, memory-backed):

```
yarn workspace @quereus/isolation run test
```

The load-bearing new tests are in `describe('atomic multi-table commit (torn-commit fix)')`.
They register a `FaultyFlushModule` (a `MemoryTableModule` whose underlying `update` throws on
the commit-flush path — recognised by `trustedWrite`, so user DML is untouched) **as the
underlying of an `IsolationModule`** (note: the module must be *wrapped*, not registered
directly — that was a bug in an early draft of these tests). Cases:

- **happy path** — BEGIN; write A and B; COMMIT → both durably present.
- **SECOND table fails** — arm failure on B; COMMIT throws; assert **both A and B empty**
  (this is the reproduced torn-commit; before the fix A was left committed).
- **FIRST table fails** — order-independence.
- **pre-existing rows** — an aborted commit leaves the pre-transaction committed state intact
  (table A keeps only its autocommit row, not the staged INSERT).
- **single-table** — degenerate one-overlay case unchanged.

**Regression-proof performed:** temporarily committing per-table inside the coordinator
(old torn behavior) turns the SECOND-table and pre-existing tests **red** ("table a must NOT
be left committed"), confirming the tests actually catch the defect. Reverted.

Full validation run this ticket:
- `yarn workspace @quereus/isolation run test` → **146 passing**.
- `yarn test` (whole monorepo) → **6481 + 146 + all others passing, exit 0** (the
  `boom`/`batch write failed`/`iterate failed` console lines are deliberate fault-injection
  from *other* suites, all reporting passing).
- `yarn workspace @quereus/isolation run typecheck`, `yarn workspace @quereus/quereus run
  typecheck`, `yarn lint` → all clean.
- The isolation **test** file is excluded from `tsc` (isolation `tsconfig` excludes `test`),
  so it was separately typechecked via a throwaway `tsconfig` including `test` → clean.

## What a reviewer should scrutinise (known gaps — treat tests as a floor)

1. **True store-atomic path is NOT exercised here.** The new tests use a *memory*
   underlying, which proves the two-phase ordering and the clean data-driven abort, but does
   **not** prove the single-`AtomicBatch.write()` behavior on a real shared-coordinator store
   (IndexedDB/LevelDB with `beginAtomicBatch`). `yarn test:store` runs the quereus logic
   tests against LevelDB but those don't wrap the store in the isolation layer, so they
   don't cover isolation+store either. A targeted "one atomic batch for a 2-table isolated
   commit" assertion (à la the IndexedDB plugin's `atomic-dml.spec.ts` single-transaction
   spy) would live in the **plugin** package, not isolation. **Deferred** — reviewer to weigh
   whether to spawn a `debt-` ticket for it. This is a coverage gap, not a known defect.

2. **No new test for the poison + multi-table abort path.** The coordinator throws on any
   poisoned overlay before applying anything (mirroring the removed `assertOverlayUsable`).
   Existing ALTER/poison tests still pass (in the 146), but none specifically asserts
   "poisoned overlay in a multi-table commit aborts atomically with no earlier table
   committed." Low risk (the throw precedes all applies), but a focused test would harden it.

3. **Interaction with `IsolatedConnection.commit()`'s trailing connection commits.** After
   `onConnectionCommit()` (→ coordinator commits the underlyings and clears overlays),
   `IsolatedConnection.commit()` still calls `overlayConnection?.commit()` and
   `underlyingConnection?.commit()`. For the covering registered connection
   `underlyingConnection` is `undefined`, and a store's `commit()` is idempotent
   (`isInTransaction()` guard), so these are no-ops/harmless — verified by the green suite —
   but a reviewer should confirm the reasoning for non-covering connections and the
   pre-aligned overlay connections registered by `ensureOverlay`.

4. **Table-level `IsolatedTable.commit()/begin()/rollback()` look vestigial.** The database
   transaction system drives *connections*, not tables. I routed `commit()` through the
   coordinator for consistency but left `begin()`/`rollback()` untouched. If these are truly
   dead, a follow-up could remove them; I did not, to keep the diff scoped.

## Tripwire parked (not a ticket)

- **Memory-underlying commit-phase infra failure can still tear.** This is fine *now* and
  only "trips" if someone expects full crash-atomicity from the default memory vtab. It is a
  documented architectural contract, parked in `docs/design-isolation-layer.md`
  § "Commit Failure Recovery" and in the `commitConnectionOverlays` doc comment — the right
  home for an architectural conditional with no single code site.
