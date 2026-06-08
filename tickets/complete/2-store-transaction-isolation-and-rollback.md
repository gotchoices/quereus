description: Close out the isolation-store wiring + core scenario tests (already shipped); confirm per-bug exclusions are individually owned by spawned implement tickets
prereq: none
files:
  packages/quereus/test/logic.spec.ts
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
----

## State at review entry

The original plan ticket's *implementable* scope has shipped on `main`:

- `packages/quereus/test/logic.spec.ts:448-554` — logic harness wires `createIsolatedStoreModule({ provider })` (not bare `StoreModule`), with `closeAll()` teardown wrapped in try/catch for Windows lock contention, and `MEMORY_ONLY_FILES` populated with per-bug rationale comments.
- `packages/quereus-isolation/src/isolation-module.ts:207-263` — `connect()` honours `_readCommitted` and `closeAll()` is exposed.
- `packages/quereus-isolation/src/isolated-table.ts:30-54` — `readCommitted` constructor flag fast-paths `query()` to the underlying table.
- `packages/quereus-store/src/common/store-table.ts` — table-level `begin/commit/rollback` exposed for `flushOverlayToUnderlying`.
- `packages/quereus-store/test/isolated-store.spec.ts:199-280` — read-your-own-writes UPDATE test (scenario A) and failed-commit deferred-constraint rollback test (scenario B/C).

## Why this is in review/

Plan stage's normal job is to advance to implement/. Here, the implementation has already been committed in the course of prior agent runs. There is no remaining implementation scope — only verification and follow-on tracking — so this is parked in review/ rather than spinning a no-op implement ticket.

## Review focus

- `yarn test` (memory mode) — confirm no regressions; expected ~2443 passing.
- `yarn test:store` — confirm the suite is green with the current `MEMORY_ONLY_FILES` exclusions in place.
- Spot-check `isolated-store.spec.ts` covers scenarios A (read-your-own-writes), B (rollback discards overlay), and C (failed COMMIT rolls back).
- Confirm every entry in `MEMORY_ONLY_FILES` either:
  - Has an explicit "by design memory-only" rationale (`05-vtab_memory`, `83-merge-join`, `103-database-options-edge-cases`, `105-vtab-memory-mutation-kills`), OR
  - Is owned by a spawned implement ticket (see "Spawned follow-ons" below), OR
  - Has had its underlying bug fixed and can be re-evaluated for re-enabling (see `re-evaluate-store-mode-exclusions`).

## Spawned follow-ons (implement/)

Each remaining isolation-layer bug is its own implement ticket, with the originally-affected sqllogic file(s) cited. The exclusions stay in `MEMORY_ONLY_FILES` until the corresponding ticket lands and the file passes.

- `isolation-cross-layer-unique-on-conflict` — IsolatedTable does not detect UNIQUE/PK conflicts across overlay+underlying; `flushOverlayToUnderlying` does not forward `onConflict`. Affects 04-transactions, 47-upsert, 102-unique-constraints.
- `isolation-deferred-constraint-ambiguity` — DeferredConstraintQueue throws "multiple candidate connections" because IsolatedConnection and overlay's MemoryVirtualTableConnection both register for the same name. Affects 40-constraints, 41-foreign-keys.
- `isolation-fk-cascade-through-overlay` — Multi-row CASCADE DELETE through isolation leaves child rows behind. Affects 29-constraint-edge-cases, 43-transition-constraints.
- `isolation-update-pk-change-tombstone` — UPDATE that changes the PK inserts a new overlay row but does not tombstone the old one. Affects 41-fk-cross-schema.
- `isolation-returning-delete-overlay-visibility` — DELETE … RETURNING and DELETE-as-subquery do not observe overlay rows when merged. Affects 42-returning, 44-orthogonality.
- `isolation-alter-column-overlay-data-loss` — ALTER COLUMN through isolation rebuilds overlay schema and drops pending writes. Affects 41.2-alter-column.
- `isolation-savepoint-rollback-undefined-schema` — `IsolatedConnection.rollbackToSavepoint` → `MemoryVirtualTableConnection.rollbackToSavepoint` → `TransactionLayer` constructor with undefined schema. Affects 101-transaction-edge-cases.
- `re-evaluate-store-mode-exclusions` — sweep `MEMORY_ONLY_FILES` for entries whose underlying bug has since been fixed (e.g. drop-create race, PK-DESC iteration, ALTER RENAME, ADD COLUMN nullability) and remove ones that now pass.

## Already-resolved-by-other-tickets (no separate follow-on needed)

Per `complete/` summaries:

- `2-isolation-overlay-bugs` (savepoint rollback ordering + insert-after-delete) — fixed.
- `3-store-drop-create-race` — `SchemaManager.dropTable` now async-awaited; map-clear-before-await ordering. Resolves the "DROP + re-CREATE race" category in the original plan.
- `3-store-pk-desc-iteration-order` — DESC-direction byte-encoding lands at storage layer. Resolves the "PK DESC iteration order not preserved by the merge" category.
- `3-store-alter-table-rename-unsupported` — `VirtualTableModule.renameTable` hook + LevelDB provider directory rename. Resolves the "ALTER TABLE RENAME loses data" category.
- `2-store-unique-constraint-not-enforced` — StoreTable now enforces non-PK UNIQUE with intra-transaction visibility. Underlying half of the cross-layer UNIQUE story is done; only the IsolatedTable / `flushOverlayToUnderlying onConflict` half remains (now owned by `isolation-cross-layer-unique-on-conflict`).

## Decision log (matches Option A from the plan)

The plan ticket asked the reviewer to choose Option A (fix isolation bugs as separate tickets), B (accept wide exclusions), or C (revert harness to non-isolated `StoreModule`). The shipped state is the **Option A** approach: harness wired through isolation, exclusions accepted *temporarily* with per-bug comments, and individual implement tickets spawned (above). Re-enabling each excluded file is gated on its corresponding implement ticket.

## Update needed in dependent ticket

`tickets/plan/3-store-fk-check-false-positive.md` notes its prereq as "still in tickets/fix/, not yet landed". The wiring + scenario A/B/C support has now landed; the prereq is satisfied. The reviewer may either:
- Re-run `yarn test:store -- --grep 41-foreign-keys` and, if the CASCADE UPDATE block now passes, transition that ticket to complete/ as resolved-by-dependency, or
- If still failing, re-scope it to a narrower deferred-constraint evaluator overlay-visibility issue (which would make it overlap with `isolation-deferred-constraint-ambiguity` — fold it in there if so).

The reviewer should make this decision concretely after running the targeted test in store mode.

## Validation TODO

- Run `yarn test` and confirm green (no regressions in memory mode).
- Run `yarn test:store` and confirm green with current exclusions.
- Spot-check the comment on each `MEMORY_ONLY_FILES` entry maps to either an "implement/" ticket above or a "by design" rationale.
- Re-test `41-foreign-keys.sqllogic` under store mode and update `3-store-fk-check-false-positive.md` accordingly.
- If all green, advance to complete/ with a one-page summary.
