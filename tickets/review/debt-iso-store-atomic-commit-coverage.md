description: Review a new test that proves the isolation layer commits a multi-table transaction to a persistent store as one atomic write, so a crash mid-commit can't leave some tables saved and others not.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/isolation-atomic-commit.spec.ts   # NEW — the test added by this ticket
  - packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts                 # the spy pattern it mirrors
  - packages/quereus-isolation/src/isolation-module.ts                        # commitConnectionOverlays — code under test
  - packages/quereus-isolation/src/flush.ts                                   # applyOverlayToUnderlying (apply-only half)
  - packages/quereus-store/src/common/transaction.ts                          # coordinator.commit — the one-AtomicBatch path
difficulty: easy
----

# Review: isolation-coordinator → shared-store single-batch commit coverage

## What this ticket did

Added `packages/quereus-plugin-indexeddb/test/isolation-atomic-commit.spec.ts`
(3 tests) proving the previously-untested seam: **an `IsolationModule` whose
underlying is a real shared-coordinator `quereus-store` collapses a multi-table
commit into ONE atomic store batch.**

This was coverage debt only — the implementation (`commitConnectionOverlays`'s
apply-all-then-commit-all two-phase flush) was believed correct and is unchanged.
No production code was touched. The tests pass, confirming the guarantee holds;
they did **not** surface a defect (which would have flipped this to a bug ticket).

## Why the seam was uncovered before

- The isolation package's own multi-table tests (`isolation-layer.spec.ts`
  § "atomic multi-table commit") use a **memory** underlying — per-table commit
  domains, so they can prove two-phase *ordering* and a clean data-driven abort
  but can NEVER exercise the shared-batch path.
- `atomic-dml.spec.ts` proves the **store's own** single-transaction atomicity but
  without the isolation layer on top.
- So "isolation coordinator drives a shared-coordinator store" — the exact path
  that delivers crash-atomicity — had no direct assertion. This test is that
  assertion.

## How it works (for the reviewer)

Mirrors `atomic-dml.spec.ts` exactly:
- Registers `IsolationModule({ underlying: new StoreModule(provider) })` over a
  real `IndexedDBProvider` (fake-indexeddb).
- Spies on `IDBDatabase.prototype.transaction` (prototype, not instance — the
  manager swaps its `db` on every version upgrade) and records `readwrite` txns
  while a `recording` flag is on. The flag is on ONLY around the statement under
  test, so warmup/DDL traffic is excluded.
- The load-bearing assertion is the **shape** of the commit (how many rw txns,
  which stores), not just final visibility — a visibility-only test passes on a
  torn per-table commit too.

Two PK-only tables `a`, `b` (each owns exactly one data store: `main.a`, `main.b`,
via `buildDataStoreName`), seeded outside the recording window so both stores are
materialized before the recorded COMMIT.

## The three tests (use cases to validate)

1. **`a two-table commit writes BOTH tables in ONE rw tx spanning {a, b}`** —
   `BEGIN; insert a; insert b; COMMIT`, recorded around the whole block. Asserts
   exactly ONE `readwrite` tx and that it spans both `main.a` and `main.b`. This
   is the core claim: the coordinator's first `commit()` flushes every table's
   buffered ops in one `AtomicBatch.write()`.
2. **`fallback (no atomic batch): ... TWO separate single-store rw txns`** — the
   discriminator control. Stubs `provider.beginAtomicBatch = () => undefined`,
   forcing the coordinator's per-store loop, and asserts the OPPOSITE shape (two
   single-store rw txns, one `a`-only and one `b`-only). Without this, a spy that
   silently recorded nothing would make test 1's "length 1" vacuously pass.
3. **`a failure during the atomic batch write leaves NEITHER table committed`** —
   crash-atomicity, the case the memory tests cannot cover. Wraps the provider's
   atomic batch so `write()` rejects after all ops are queued (an IO fault at the
   single all-or-nothing commit point), asserts COMMIT throws, and asserts BOTH
   tables keep only their pre-transaction seed row.

## Validation performed

- `yarn workspace @quereus/plugin-indexeddb run test` → **76 passing** (3 new +
  73 pre-existing; no regressions in `atomic-dml.spec.ts`, which patches the same
  IDB prototype — each suite restores its patch in `afterEach`).
- Standalone `tsc --noEmit --strict` on the new spec → clean. NOTE: the plugin's
  own `typecheck` script (`tsc --noEmit`) uses a tsconfig whose `include` is
  `src/**/*` only — it does **not** typecheck `test/`. Specs run via Node's
  experimental type-stripping (annotations stripped, not checked). So spec type
  errors are NOT caught by `yarn typecheck` or `yarn lint` for this package; the
  standalone tsc run above is the only type gate. Same gap applies to the
  pre-existing `atomic-dml.spec.ts`.

## Known gaps / reviewer attention

- **IndexedDB only.** LevelDB is the other shared-coordinator store; the ticket
  said "pick whichever has the lighter harness" and IndexedDB already had the spy
  pattern. The coordinator code is underlying-agnostic, so LevelDB is believed
  equivalent, but it is not directly covered here. Low value to duplicate.
- **Crash-atomicity is simulated at the batch boundary**, not a true process
  crash: test 3 rejects `write()` before it lands rather than killing mid-flush.
  For IndexedDB the atomic batch IS one native IDB transaction (all-or-nothing at
  the IDB layer), so "reject before commit" faithfully models the guarantee — but
  it does not exercise a partial physical write, which fake-indexeddb cannot
  produce anyway.
- **Tombstone/delete and update flush paths not multi-table-tested here.** Test 1
  uses two inserts. `applyOverlayToUnderlying`'s delete-before-insert ordering and
  the update-vs-insert branch are covered by `atomic-dml.spec.ts` (single table)
  and the memory-backed isolation tests, but not in the multi-table shared-batch
  shape. A reviewer wanting belt-and-suspenders could add a mixed
  insert-on-A + delete-on-B variant; judged low-value since the batch collects all
  ops uniformly regardless of op type.
- **No tripwires filed** — nothing conditional was noticed in the code under test.
