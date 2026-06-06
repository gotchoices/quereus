description: Atomicity fix for `IsolationModule.alterTable` — overlay backfill is dry-run validated BEFORE the shared underlying is mutated, so a NOT NULL / tombstone rejection leaves base + catalog untouched instead of diverging. Reviewed; production fix sound, one vacuous test assertion fixed inline.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md
----

## What was implemented

`IsolationModule.alterTable` previously mutated the shared (committed, auto-committing,
non-rollback-able) underlying FIRST, then migrated each per-connection overlay. An
overlay-migration throw (the per-row NOT NULL backfill in `computeAddColumnValue`, or the
missing-tombstone INTERNAL guard) left the underlying altered while the engine — seeing the
throw propagate — skipped the catalog update → base/catalog divergence.

The fix moves the fallible work ahead of the irreversible mutation (pre-validate, then mutate),
mirroring the engine's pre-mutation `validateNotNullBackfill` in `runtime/emit/alter-table.ts`.
Observable throw semantics are unchanged; only the timing — and thus atomicity — changes.

Key pieces (all in `packages/quereus-isolation/src/isolation-module.ts`):
- `deriveAddColumnBackfill(change, db, tableName)` resolves the new column's `notNull`/`name`
  via `columnDefToSchema(change.columnDef, default_column_nullability === 'not_null')` — the
  exact resolution both underlyings (`manager.ts addColumn`, `store-module.ts addColumn`) use —
  so it is valid BEFORE the underlying mutation and cannot drift from what the underlying enforces.
- `validateOverlayMigration(oldState, addColumnCtx)` dry-runs the migration-fallible work
  (tombstone guard + per-row `computeAddColumnValue`) without mutating anything.
- `alterTable` validates every affected overlay BEFORE `underlying.alterTable`, then reuses the
  same `addColumnCtx` for the real migration.
- README gained an "Atomic ALTER" Key-Feature note.

## Review findings

### Scope of the adversarial pass
Read the full implement diff (commit `573d599a`) before the handoff summary. Scrutinized the
production fix for ordering/atomicity correctness, the nullability-resolution refactor, the
backfill-evaluator lifetime, NOT NULL coverage completeness, the white-box test's load-bearing
claim, type safety, and doc accuracy. Cross-checked the engine (`runtime/emit/alter-table.ts`),
both underlyings (`vtab/memory/layer/manager.ts` + `base.ts`, `quereus-store/.../store-module.ts`),
and the `VirtualTable` / `MemoryTable` schema accessors.

### MAJOR — vacuous white-box atomicity assertion (FIXED INLINE)
The two rejection tests' load-bearing white-box check —
`getUnderlyingState('main', t)!.underlyingTable.tableSchema!.columns.length` — was **vacuous**.
`MemoryTable.tableSchema` is a per-instance field set once at connect time (`table.ts:56`); the
module-level `MemoryTableModule.alterTable` → `manager.addColumn` path this layer drives updates
only `manager.tableSchema`, never the cached instance field. The live schema is exposed via
`getSchema()` (returns `manager.tableSchema`), not the `.tableSchema` field.

Consequence: the accessor always returned the pre-ALTER count whether or not the underlying was
mutated. **Empirically proven**: temporarily reordering the production code to the pre-fix
mutate-then-validate ordering left all 98 tests green — the assertion did NOT catch the very
regression it claimed to guard. The implementer's explicit "reviewer should confirm it actually
fails against the old ordering (it does)" was incorrect.

Fix (test-only — the production fix itself is correct): the `underlyingColumnCount` helper now
reads the live schema via the MemoryTable's `getSchema()` (narrowed structurally, since
`getSchema()` is not on the base `VirtualTable` type and this suite pins the underlying to
memory). **Re-proven**: with the buggy ordering re-applied the two rejection tests now FAIL
(`actual 3, expected 2` — the phantom column); with the correct ordering all 98 pass. The fix
was localized and fully verified in this pass, so it was applied inline rather than filed as a
new ticket.

### Verified correct — no change needed
- **Ordering / atomicity.** `validateOverlayMigration` runs for every affected overlay (across
  all connections) before `underlying.alterTable`; any throw leaves underlying + catalog +
  overlays untouched. Atomic across connections.
- **Nullability resolution.** `columnDefToSchema(columnDef, defaultNotNull)` matches both
  underlyings verbatim (confirmed in `manager.ts:1419`, `store-module.ts:631`). The
  `default_column_nullability='not_null'` test exercises the option-derived path.
- **NOT NULL coverage is complete, not partial.** The literal / no-default NOT NULL case is NOT
  silently missed by `computeAddColumnValue` (which only checks NOT NULL on the evaluator path):
  the engine's pre-mutation `validateNotNullBackfill` runs a **merged** read
  (`select 1 from t limit 1`) that already sees staged overlay rows via read-your-writes, so it
  rejects that case before `IsolationModule.alterTable` is even called. The isolation layer's
  evaluator-path check correctly handles only the remaining case the engine cannot (a per-row
  `new.<col>` default producing NULL for a specific row). Coherent division of responsibility.
- **Evaluator lifetime.** The engine builds `backfillEvaluator` with `rowSlot`/`checkSlot` and
  closes them in a `finally` that runs only AFTER `module.alterTable` returns
  (`alter-table.ts:325-332`). Both the dry-run and the migrate pass execute inside that window,
  so the slots are valid for both; running the (deterministic) evaluator twice per row is safe.
- **Idempotence / no side effects** on the dry run: it discards computed values and never mutates
  a tree or overlay.

### Checked — empty or out of scope (stated explicitly)
- **Docs.** README "Atomic ALTER" note is accurate. `docs/design-isolation-layer.md` line 504-507
  ("DDL bypasses the overlay, goes directly to underlying") is a high-level design doc whose
  statement predates the overlay-migration machinery entirely — pre-existing design-vs-impl drift,
  unrelated to this ticket's timing change; not rewritten here.
- **Store path.** `yarn test:store` not run (slow, not agent-runnable). The fix is in
  `IsolationModule.alterTable`, which is underlying-agnostic. Checked
  `quereus-store/test/isolated-store.spec.ts` for an analogous vacuous white-box assertion — it
  has none (no `getUnderlyingState`/`.tableSchema.columns` schema probe), so the bug fixed above
  is isolation-suite-local. A belt-and-suspenders `yarn test:store` can be run out-of-band.
- **Cross-connection abort semantics.** Unchanged; desirability parked in backlog
  `alter-isolation-overlay-failure-cross-connection-semantics`. This ticket changed timing, not
  blast radius.
- **Residual unreachable post-mutation throw sites** (`overlayModule.create`,
  `newOverlayTable.update`) — left as INTERNAL invariants; not reachable on data grounds for the
  supported change types. Acceptable.
- **`_exhaustive: never` hint** in `translateOverlayRow`'s default case — pre-existing intentional
  exhaustiveness check, untouched.

### Validation
- `yarn workspace @quereus/isolation test` → **98 passing, 0 failing**.
- `yarn workspace @quereus/isolation run build` → exit 0 (typecheck clean).
- Discriminator proof: production reorder → 2 failing (correctly); reverted → 98 passing.
- No lint script for the isolation package (only `packages/quereus` has one).
- Net production diff: none (the implement-stage `isolation-module.ts` was already correct). Only
  the test helper changed.

## End
