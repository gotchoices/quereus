description: DeferredConstraintQueue.findConnection throws "multiple candidate connections" because both IsolatedConnection and overlay's MemoryVirtualTableConnection register for the same table
prereq: none
files:
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus-isolation/src/isolated-connection.ts
  packages/quereus/test/logic/40-constraints.sqllogic
  packages/quereus/test/logic/41-foreign-keys.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause

When the isolation layer wraps a write, two `VirtualTableConnection`s end up registered against the same `schema.table` key on the database:

1. The `IsolatedConnection` that the wrapper itself registers, which routes through the overlay+underlying.
2. The overlay's own `MemoryVirtualTableConnection`, which the overlay table registers internally when written to.

`DeferredConstraintQueue.findConnection` (`packages/quereus/src/runtime/deferred-constraint-queue.ts:159-180`) sees both candidates and throws `Deferred constraint execution found multiple candidate connections for table <name>`.

## Affected sqllogic

- `40-constraints.sqllogic` — deferred CHECK / FK assertions inside a transaction.
- `41-foreign-keys.sqllogic` — any deferred FK evaluator (most CASCADE / SET NULL flows).

## Fix approach

Two reasonable directions; pick one with an eye toward the isolation-layer's encapsulation:

- **A — Hide the overlay connection from public lookup.** Mark the overlay's internal `MemoryVirtualTableConnection` as private/internal so the database's `getActiveConnections()` enumeration does not return it. The overlay would still use it internally for savepoint/transaction management; only the wrapping `IsolatedConnection` would be visible to constraint evaluators.
- **B — Prefer the IsolatedConnection at lookup time.** Teach `findConnection` to break ties: if any candidate is an `IsolatedConnection`, prefer it (it is the canonical connection for the table). Fall back to the existing single-candidate path otherwise.

Approach **A** is cleaner architecturally — the overlay is an implementation detail of the isolation layer and should not leak into public connection enumeration. Approach **B** is a one-line tiebreak in `findConnection` and unblocks the failing tests faster.

Recommended: start with A. If the overlay's connection cannot be cleanly hidden from `getActiveConnections()` (e.g. because it is needed for some other lookup), fall back to B.

## Validation

- New unit test in `packages/quereus-store/test/isolated-store.spec.ts`: a deferred FK violation inside a transaction surfaces the FK error at COMMIT, not the "multiple candidate connections" error.
- `yarn test:store -- --grep "40-constraints|41-foreign-keys"` → both files passing.
- `yarn test` (memory mode) — no regressions; in particular, deferred constraints still work for non-isolated tables.

## TODO

- Pick A or B (default A).
- Implement the chosen fix.
- Add the unit test described in Validation.
- Remove `40-constraints.sqllogic` and `41-foreign-keys.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
- After landing, re-test `tickets/plan/3-store-fk-check-false-positive.md` — this fix may resolve it too.
