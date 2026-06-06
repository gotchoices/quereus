description: Review the atomicity fix for `IsolationModule.alterTable` — overlay backfill is now dry-run validated BEFORE the shared underlying is mutated, so a NOT NULL / tombstone rejection leaves base + catalog untouched instead of diverging.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md
----

## What was implemented

The defect: `IsolationModule.alterTable` mutated the shared (committed, auto-committing,
non-rollback-able) underlying via `underlying.alterTable` FIRST, then migrated each
per-connection overlay. An overlay-migration throw — the per-row NOT NULL backfill check in
`computeAddColumnValue`, or the missing-tombstone INTERNAL guard — left the underlying altered
while the engine, seeing the throw propagate, skipped the catalog update → base/catalog
divergence (and half-migrated overlays).

The fix moves the fallible work ahead of the irreversible mutation (pre-validate, then mutate),
mirroring the engine's existing pre-mutation `validateNotNullBackfill` in
`runtime/emit/alter-table.ts`. Observable throw semantics are unchanged; only the **timing** —
and thus atomicity — changes.

### Changes (all in `packages/quereus-isolation/src/isolation-module.ts`)

- **`deriveAddColumnBackfill(change, updatedSchema)` → `deriveAddColumnBackfill(change, db, tableName)`.**
  Now resolves the new column's `notNull`/`name` via
  `columnDefToSchema(change.columnDef, db.options.getStringOption('default_column_nullability') === 'not_null')`
  — exactly how both underlyings (`manager.ts addColumn`, `store-module.ts addColumn`) resolve
  it — instead of reading the last column of `updatedSchema` (which does not exist before the
  underlying mutation). `columnDefToSchema` newly imported from `@quereus/quereus`. `tableName`
  threaded in for the error message; `ColumnSchema` type import dropped (now unused).

- **New `validateOverlayMigration(oldState, addColumnCtx)`.** Dry-runs the migration-fallible
  work without mutating anything: mirrors the migrate-loop guard (`hasChanges && schema && query`),
  fires the tombstone-present INTERNAL guard, and for addColumn scans every staged row through
  the SAME `computeAddColumnValue` the real migration uses (so dry-run and real run cannot
  diverge), discarding the result. Tombstone rows short-circuit to `null` inside
  `computeAddColumnValue`; a NOT-NULL-violating evaluated row throws CONSTRAINT here.

- **`alterTable`** now builds `addColumnCtx` up front and calls `validateOverlayMigration` for
  every `affected` overlay BEFORE `underlying.alterTable`. The same `addColumnCtx` is passed into
  `migrateOverlayForAlter` (its signature gained the param; it no longer calls
  `deriveAddColumnBackfill` itself). Doc comment updated with the atomicity guarantee.

- **README** gained an "Atomic ALTER" Key-Feature note.

## Use cases / behavior to validate

- **Atomic rejection (explicit NOT NULL):** `BEGIN; INSERT (x=NULL); ALTER ADD COLUMN c INTEGER
  NOT NULL DEFAULT (new.x)` — throws CONSTRAINT ("not null") AND the underlying is unmutated.
  The committed base is empty (insert is staged-only), so the underlying's own backfill would
  succeed — only the overlay row is un-backfillable; this is the exact divergence scenario.
- **Tombstone short-circuit success:** a staged DELETE (tombstone) + a satisfiable staged INSERT,
  then `ALTER ADD COLUMN tag NOT NULL DEFAULT (new.id)` — succeeds, tombstone never trips NOT NULL.
- **`default_column_nullability='not_null'` implicit NOT NULL:** added column with NO explicit
  `not null` still resolves NOT NULL via the option; un-backfillable staged row → atomic rejection.
- **Happy path:** satisfiable per-row default over staged inserts backfills each staged row from
  its own sibling value and survives commit (read-your-writes) — guards the refactor.

### White-box assertion of atomicity
The tests assert `isolatedModule.getUnderlyingState('main', t)!.underlyingTable.tableSchema!.columns.length`
equals the pre-ALTER count after a rejection. Before the fix the underlying would already carry
the phantom new column. This is the load-bearing discriminator — reviewer should confirm it
actually fails against the old ordering (it does: old code ran `underlying.alterTable` first).

## Tests added
4 tests in `packages/quereus-isolation/test/isolation-layer.spec.ts` under
`describe('ALTER TABLE ADD COLUMN atomic pre-validation')` (the 4 cases above). Also removed a
genuinely-unused `VirtualTable` type import from that file (cleanup, pre-existing).

## Validation run
- `yarn workspace @quereus/isolation test` → **98 passing, 0 failing**.
- `yarn workspace @quereus/isolation run build` → exit 0 (typecheck clean).
- No lint script for the isolation package (only `packages/quereus` has one).

## Known gaps / honest flags for the reviewer

- **Store path NOT run inline.** `yarn test:store` is slow and was deferred. The fix is in
  `IsolationModule.alterTable`, which is underlying-agnostic — the store underlying only differs in
  what `underlying.alterTable` does, not in the pre-validation ordering. `quereus-store/test/
  isolated-store.spec.ts` already covers the analogous ADD COLUMN / NOT NULL / tombstone cases
  through `createIsolatedStoreModule`; those exercise the same new code path with a store
  underlying and pass via the normal `yarn test`. A reviewer wanting belt-and-suspenders can run
  `yarn test:store` out-of-band, but it is not expected to regress.

- **Residual unreachable post-mutation throw sites.** After pre-validation,
  `migrateOverlayForAlter`'s remaining throw sites are `overlayModule.create` and
  `newOverlayTable.update` — not reachable on data grounds for the supported change types (a valid
  overlay schema creates cleanly; appending a column or re-inserting previously-valid rows under
  the post-alter index set violates nothing). If one DID throw, the underlying is already committed
  and divergence recurs — but reverting is non-transactional and lossy, so it is left as an
  INTERNAL invariant violation. Reviewer should sanity-check that no realistic input reaches them.

- **Cross-connection abort semantics unchanged (parked).** `affected` spans every connection's
  overlay, so connection B's un-backfillable staged row still aborts connection A's ALTER — now
  atomically, but the desirability of that cross-connection coupling is a separate question parked
  in backlog `alter-isolation-overlay-failure-cross-connection-semantics`. This ticket changed only
  the timing, not the blast radius.

- **`migrateOverlayForDropIndex` / non-addColumn changes** were considered and need no change:
  dropIndex copies rows verbatim (no backfill/guard); dropColumn/rename/alterColumn append/remove
  nothing fallible on data grounds. Only the tombstone-present guard runs for non-addColumn ALTERs.

- **Cost note:** addColumn pre-validation adds one extra full scan of each affected overlay
  (staged uncommitted rows only — typically small). Accepted for correctness.

- Pre-existing `_exhaustive: never` hint in `translateOverlayRow`'s `default` case is an
  intentional exhaustiveness check, untouched by this work.
