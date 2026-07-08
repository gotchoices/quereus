description: Added and reviewed a test proving the isolation layer commits a multi-table transaction to a persistent store as one atomic write, so a crash mid-commit cannot leave some tables saved and others not.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/isolation-atomic-commit.spec.ts   # the test under review
  - packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts                 # the spy pattern it mirrors
  - packages/quereus-isolation/src/isolation-module.ts                        # commitConnectionOverlays — code under test
  - packages/quereus-isolation/src/flush.ts                                   # applyOverlayToUnderlying (apply-only half)
  - packages/quereus-store/src/common/transaction.ts                          # coordinator.commit — the one-AtomicBatch path
  - packages/quereus-store/src/common/store-module.ts                         # wires the atomicBatchFactory
----

# Complete: isolation-coordinator → shared-store single-batch commit coverage

## What landed

`packages/quereus-plugin-indexeddb/test/isolation-atomic-commit.spec.ts` (3
tests) proving the previously-untested seam: an `IsolationModule` over a real
shared-coordinator `quereus-store` collapses a multi-table commit into ONE atomic
store batch. Coverage debt only — no production code changed. Tests pass; they did
not surface a defect.

The three tests:
1. two-table commit → exactly ONE `readwrite` IDB tx spanning `{main.a, main.b}`.
2. fallback control (`beginAtomicBatch` stubbed to `undefined`) → the OPPOSITE
   shape (two single-store rw txns), proving the spy discriminates atomic from torn.
3. crash-atomicity: `AtomicBatch.write()` armed to reject → COMMIT throws, BOTH
   tables keep only their pre-transaction seed row.

## Review findings

### Verified correct (checked, no action)

- **The shape assertions are load-bearing, not vacuous.** Test 2 is a genuine
  discriminator: stubbing `provider.beginAtomicBatch = () => undefined` forces the
  coordinator's per-store fallback loop and asserts two single-store txns, so
  test 1's "length 1" cannot pass on a torn commit. Confirmed the factory
  (`store-module.ts:2017`, `() => this.provider.beginAtomicBatch?.()`) is
  re-evaluated per commit (`transaction.ts:236`) and reads the SAME provider
  object the test mutates — so the stub reliably takes effect.
- **Test 3 genuinely proves atomicity, not a false pass.** Traced the abort flow:
  `coordinator.commit`'s `finally` calls `clearTransaction()`, discarding all
  buffered ops when `write()` rejects, so `id=2` never persists to either store.
  The subsequent seed-only read also confirms the engine auto-rolls-back the
  overlays after the failed COMMIT — had the overlay survived, the merged read
  would show `id=2` alongside the seed. It shows only the seed, so both halves
  (underlying clean + overlay discarded) hold. Wired to the real
  `IsolationModule.commitConnectionOverlays` two-phase flush and
  `applyOverlayToUnderlying`, both read and confirmed consistent with the test's
  assumptions.
- **Spy/teardown hygiene.** Prototype patch (not instance) is correct — the
  manager swaps `db` on every version upgrade. `afterEach` restores the patch
  FIRST, and a fresh `provider`/`db` is built per test in `beforeEach`, so the
  bound-fn restore in test 3 (`origBegin = ....bind(provider)`) does not leak
  across tests. `atomic-dml.spec.ts` patches the same prototype and both suites
  restore in `afterEach` — no cross-suite bleed (76 passing confirms).

### Correction to the implement handoff

- The handoff stated spec type errors are "NOT caught by `yarn typecheck` or
  `yarn lint`" and that a standalone `tsc` is "the only type gate." Understated:
  the package ships **`tsconfig.test.json`** (extends base, `strict: true`,
  `include: ["test/**/*", "src/**/*"]`). Running `tsc -p tsconfig.test.json
  --noEmit` type-checks the spec cleanly (exit 0, verified). The real gap is
  narrower: no npm **script** is wired to that config (`typecheck` uses the
  src-only `tsconfig.json`), so nothing runs it automatically. Same shape as the
  pre-existing `atomic-dml.spec.ts`. See tripwire below.

### Validation performed this pass

- `yarn workspace @quereus/plugin-indexeddb run test` → **76 passing** (no
  regressions).
- `yarn workspace @quereus/plugin-indexeddb run lint` → `No lint configured`
  (intentional no-op; the only real lint lives in `packages/quereus`, and this
  change touches neither its src nor its tests).
- `tsc -p tsconfig.test.json --noEmit` in the plugin package → exit 0 (spec
  type-checks strict-clean).

### Findings dispositioned

- **Minor:** none requiring an inline fix. The test is well-constructed and
  well-documented.
- **Major (new tickets):** none.
- **Tripwire (recorded, not filed):** the plugin's `test/` files are
  type-checkable via `tsconfig.test.json` but no package script invokes it, so
  spec-level type errors escape CI for every `quereus-plugin-*` package that
  follows this layout. Fine now (specs are strict-clean today); becomes work only
  if spec type drift starts landing unnoticed. Architectural (no single code
  site), so parked here in findings rather than as a code comment — a future
  reader wiring up per-package test typechecking will meet it here.
- **Noted low-value gap (agreeing with the handoff):** test 1 uses two inserts; a
  mixed insert-on-A + delete-on-B multi-table variant is not covered here. The
  coordinator buffers ops uniformly regardless of op type and delete-before-insert
  ordering is already covered by `atomic-dml.spec.ts` (single table), so a
  multi-table mixed-op variant is belt-and-suspenders. Not filed.
- **LevelDB (the other shared-coordinator store) not directly covered.** Coordinator
  code is underlying-agnostic; IndexedDB already had the spy harness. Low value to
  duplicate. Not filed.
