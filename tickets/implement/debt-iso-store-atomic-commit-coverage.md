description: Add an end-to-end test proving that when the isolation layer commits a transaction spanning multiple tables backed by a persistent store, all those tables are written in a single atomic batch — the guarantee is implemented but never exercised against a real store.
prereq:
files:
  - packages/quereus-isolation/src/isolation-module.ts        # commitConnectionOverlays — the two-phase coordinator under test
  - packages/quereus-isolation/src/flush.ts                    # applyOverlayToUnderlying (apply-only)
  - packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts  # existing single-transaction spy pattern to mirror
  - packages/quereus-store/                                    # shared-coordinator store the isolation layer wraps
difficulty: medium
----

# Prove the isolation coordinator produces ONE atomic store batch for a multi-table commit

## Why this exists

The torn-multi-table-commit fix (`iso-torn-multi-table-commit-atomicity`, now complete)
made the isolation layer commit every table a transaction touched via one **apply-all,
then commit-all** two-phase flush (`IsolationModule.commitConnectionOverlays`). The whole
value proposition is: when the underlying is a `quereus-store` whose tables share one
module-wide coordinator over a provider with `beginAtomicBatch` (IndexedDB / LevelDB),
Phase 2's *first* `commit()` writes **every** table's ops in a single `AtomicBatch.write()`
and the remaining commits no-op — so a multi-table commit is fully atomic even against a
crash mid-commit.

That single-batch behavior is currently proven only **by construction and by reasoning**,
not by a test:

- The new tests added by the fix use a *memory* underlying. They prove the two-phase
  ordering (nothing commits until all tables apply) and a clean data-driven abort, but a
  memory vtab has per-table commit domains — it can never exercise the shared-batch path.
- `yarn test:store` runs the main `packages/quereus` logic tests against a LevelDB store,
  but those do **not** wrap the store in the isolation layer, so the isolation-coordinator
  + store seam is untested.
- The IndexedDB plugin's `atomic-dml.spec.ts` proves the *store's own* single-transaction
  atomicity, but again without the isolation layer on top.

So the exact seam that delivers crash-atomicity — "isolation coordinator drives a
shared-coordinator store" — has no coverage. The coordinator code is identical regardless
of underlying, which is why risk is low, but the guarantee is load-bearing and deserves a
direct assertion.

## What to build

A test (in the **plugin** package that owns a real shared-coordinator store — IndexedDB or
LevelDB — not in `quereus-isolation`, whose tests are memory-backed) that:

1. Registers an `IsolationModule` whose `underlying` is a real store module with
   `beginAtomicBatch` support.
2. Spies on / counts the underlying provider's atomic-batch writes (mirror the
   single-transaction spy already used in `atomic-dml.spec.ts`).
3. Runs `BEGIN; write table A; write table B; COMMIT` and asserts **exactly one**
   `AtomicBatch.write()` (or equivalent coordinator commit) covered both tables' ops.
4. Optionally: arms a failure mid-batch and asserts neither table is left committed
   (true crash-atomicity), the case the memory tests explicitly cannot cover.

## Notes

- Pick whichever store plugin has the lighter test harness for spying on batch writes;
  IndexedDB's `atomic-dml.spec.ts` already has the pattern.
- This is coverage debt, not a known defect — the implementation is believed correct. If
  the test surfaces that the coordinator does *not* collapse to one batch, that flips this
  into a bug ticket.
