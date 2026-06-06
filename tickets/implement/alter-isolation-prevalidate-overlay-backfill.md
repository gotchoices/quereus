description: Make `IsolationModule.alterTable` atomic with respect to the shared underlying by dry-run validating every affected per-connection overlay's backfill BEFORE calling `underlying.alterTable`. Today the underlying (shared base) is mutated first and the overlay migration runs after; an overlay-migration throw (NOT NULL per-row backfill rejection, or the missing-tombstone INTERNAL guard) leaves the underlying altered while the engine skips the catalog update — base/catalog divergence. Pre-validation moves the fallible work ahead of the irreversible mutation so the ALTER either fails clean (underlying + catalog untouched) or fully applies.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts
effort: medium
----

## Background / why this is the right fix

DDL in Quereus is **not transaction-scoped** and is **not rolled back**. `addColumnToBase`
(`packages/quereus/src/vtab/memory/layer/base.ts`) and the store module mutate the *shared*
committed base directly and immediately; the property test `should preserve schema DDL
through rollback` (`packages/quereus/test/property.spec.ts`) confirms a table/column change
survives `ROLLBACK` while data does not. So "revert the underlying on overlay-migration
failure" is **not** a viable strategy:

- the underlying mutation auto-commits — there is no transaction frame to unwind, and
- `dropColumn` / type-converting `alterColumn` are lossy and not generally invertible.

The base-layer ALTER is already internally atomic (build-into-local-tree, swap on success;
see `recreatePrimaryTreeWithNewColumn`). The defect is confined to the **ordering inside
`IsolationModule.alterTable`**: it calls `this.underlying.alterTable(...)` first, then
iterates the affected per-connection overlays calling `migrateOverlayForAlter`, which can
throw at:

1. the per-row NOT NULL backfill check in `computeAddColumnValue` (CONSTRAINT), and
2. the `Tombstone column '…' missing from overlay schema` guard (INTERNAL).

When either fires, the underlying is already altered (and committed), some overlays may have
already been swapped to the new layout, and the engine — seeing the throw propagate out of
`module.alterTable` — does **not** update the schema catalog. Result: shared base altered,
catalog stale, overlays half-migrated.

**Decision: pre-validate before mutating the underlying.** Run the two fallible checks above
as a dry-run pass over every affected overlay *before* `underlying.alterTable`. If any would
fail, throw then — underlying, catalog, and every overlay are untouched, so the failure is
fully atomic. This mirrors the engine's existing pre-mutation `validateNotNullBackfill` in
`packages/quereus/src/runtime/emit/alter-table.ts` (reject NOT-NULL-without-default *before*
calling the module). Current observable throw semantics are preserved (an un-backfillable
staged row still rejects the ALTER); only the timing — and thus the atomicity — changes.

> Out of scope (parked in backlog `alter-isolation-overlay-failure-cross-connection-semantics`):
> whether one connection's un-backfillable *uncommitted* staged row should be allowed to abort
> a *different* connection's ALTER at all. `affected` spans every connection's overlay for the
> table, so today connection B's bad staged row aborts connection A's ALTER. That is a separate
> semantics question (would need a "poisoned overlay" mechanism) and is intentionally not
> changed here — this ticket only makes the existing behavior atomic.

## Authoritative new-column nullability (do NOT read `columnDef.constraints` alone)

The new column's `notNull` is resolved through the session option, not just explicit
constraints: both underlyings compute it as
`columnDefToSchema(change.columnDef, db.options.getStringOption('default_column_nullability') === 'not_null')`
(see `manager.ts` `addColumn` and `store-module.ts` `addColumn`). `columnDefToSchema` is
exported from `@quereus/quereus`. Pre-validation MUST derive `newColNotNull` / `newColName`
the same way so it cannot drift from what the underlying will enforce. This also lets
`deriveAddColumnBackfill` stop depending on `updatedSchema` (which does not exist yet at
pre-validation time) — the backfill context becomes derivable purely from `change` + the
session option, and the same context is reused by the post-mutation migration.

## Design

Refactor `deriveAddColumnBackfill(change, updatedSchema)` →
`deriveAddColumnBackfill(change, db)` (or pass the resolved `defaultNotNull` boolean). It
computes the `AddColumnBackfillContext` from `change.columnDef` and
`columnDefToSchema(change.columnDef, defaultNotNull)` — no `updatedSchema` needed. The new
column is still appended last by both underlyings, so the migration's row layout assumptions
are unchanged.

Add a pre-validation pass in `alterTable`, after collecting `affected` and computing
`dropColumnIdx`, but **before** `const updated = await this.underlying.alterTable(...)`:

```
// Build the addColumn backfill context up front (undefined for other change types).
const addColumnCtx = this.deriveAddColumnBackfill(change, db);

// Dry-run every affected overlay's migration-fallible work before mutating the shared
// underlying, so a rejection leaves underlying + catalog + overlays untouched.
for (const [, oldState] of affected) {
  await this.validateOverlayMigration(oldState, addColumnCtx);
}

const updated = await this.underlying.alterTable(db, schemaName, tableName, change);
// ...existing migrate loop unchanged...
```

`validateOverlayMigration(oldState, addColumnCtx)`:
- return immediately if `!oldState.hasChanges` (an empty/clean overlay stages no rows;
  mirror the `migrateOverlayForAlter` guard);
- resolve `oldTombstoneIdx` from `oldState.overlayTable.tableSchema.columnIndexMap`; if
  missing, throw the same INTERNAL `Tombstone column '…' missing from overlay schema` error
  (the guard now fires pre-mutation);
- if `addColumnCtx` is set, scan `oldState.overlayTable.query(this.makeFullScanFilterInfo())`
  and call `this.computeAddColumnValue(addColumnCtx, row, oldTombstoneIdx)` for each row —
  reusing the exact code path the migration uses, so the dry-run and the real run cannot
  diverge. Tombstone rows short-circuit to `null` inside `computeAddColumnValue` (they never
  run the evaluator), and a NOT-NULL-violating evaluated row throws CONSTRAINT here, before
  the underlying is touched. Discard the computed values (validation only).

Keep `migrateOverlayForAlter` calling `computeAddColumnValue` as today; after pre-validation
it is guaranteed not to trip the NOT NULL / tombstone failures, so the post-mutation loop no
longer carries a reachable partial-failure path for the documented throw sites.

DRY note: the pre-validate scan and the migrate scan are structurally the same iteration. If
it reads cleanly, factor the "for each staged row compute the add-column value" iteration into
one private helper that both call (validation passes a no-op sink; migration writes the
translated row). Don't force the abstraction if it obscures the two distinct outputs.

## Edge cases & interactions

- **Tombstone short-circuit:** a staged *delete* (tombstone row) carries NULL placeholders and
  must NOT run the evaluator nor trip NOT NULL — `computeAddColumnValue` already returns `null`
  for `oldRow[oldTombstoneIdx] === 1`. The dry-run must go through `computeAddColumnValue` (not
  re-implement the check) so this holds.
- **`default_column_nullability = 'not_null'`:** a column added with no explicit `not null`
  constraint still resolves NOT NULL. Pre-validation via `columnDefToSchema` + the session
  option must reject an un-backfillable staged row in this case too. Add a test with the
  session option set.
- **Literal / folded-NULL default vs per-row evaluator:** NOT NULL is enforced only on the
  per-row `new.<col>` evaluator path (`ctx.evaluator` present). A literal/NULL default's
  nullability is gated up front by the engine; the dry-run must mirror that (don't NOT-NULL-check
  the literal path) — again guaranteed by routing through `computeAddColumnValue`.
- **Multiple overlays across connections:** `affected` includes every connection's overlay.
  Pre-validation scans all of them; the first failing one aborts atomically. (Whether that
  cross-connection abort is *desirable* is the parked backlog question — behavior here is
  unchanged, only its timing.)
- **Non-addColumn changes:** `addColumnCtx` is undefined, so the dry-run only runs the
  tombstone-present guard. dropColumn / rename / alterColumn / constraint changes append/remove
  nothing fallible to staged rows; the migration's row translation cannot throw on data grounds
  (dropColumn rebuilds indexes from the post-alter schema; rename/alter keep row width). No new
  validation needed beyond the guard.
- **Residual post-mutation throw:** after pre-validation, `migrateOverlayForAlter`'s remaining
  throw sites are `overlayModule.create` and `newOverlayTable.update` — neither is reachable on
  data grounds for the supported change types (a valid overlay schema creates cleanly; appending
  a column or re-inserting previously-valid rows under the post-alter index set does not violate
  uniqueness). If one *does* throw, the underlying is already committed and the catalog will not
  update → divergence; do NOT attempt to revert the underlying (non-transactional, lossy).
  Treat it as an INTERNAL invariant violation and leave a comment saying so. The reviewer should
  confirm no realistic input reaches it.
- **`dropIndex` analogue:** `migrateOverlayForDropIndex` runs *after* `underlying.dropIndex`
  with the same ordering, but copies rows verbatim (no backfill, no tombstone guard), so its
  only throw sites are the unreachable `create`/`update` pair above. No change required; mention
  in the PR that it was considered and is lower-risk.
- **Pre-validation cost:** for addColumn this adds one extra full scan of each affected overlay
  (staged uncommitted rows only — typically small). Acceptable for correctness; note it.

## Key tests (add to `packages/quereus-isolation/test/isolation-layer.spec.ts`)

Setup pattern is already in the spec: register an `IsolationModule({ underlying: new
MemoryTableModule() })` as `isolated`, `CREATE TABLE … USING isolated`, `BEGIN`, `INSERT`
(stages an overlay), then `ALTER`.

- **Atomic rejection — NOT NULL per-row backfill on a NULL-yielding staged row:**
  stage a row whose `new.<col>` default evaluates to NULL, run
  `ALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)` (where `x` is NULL for that
  staged row). Assert it throws CONSTRAINT, AND that the shared underlying is unchanged:
  `isolatedModule.getUnderlyingState('main','t')!.underlyingTable.tableSchema.columns` has the
  pre-ALTER column count (no phantom `c`). Asserting on `getUnderlyingState(...).tableSchema`
  is the white-box check that the mutation never happened; before the fix the column would be
  present.
- **Tombstone short-circuit success:** stage a *delete* (so the overlay holds a tombstone row)
  plus a normal staged insert that DOES satisfy the default, then run the same NOT NULL ADD
  COLUMN. Assert it succeeds and the tombstone row did not spuriously trip NOT NULL.
- **`default_column_nullability='not_null'` rejection:** `PRAGMA`/option set so the added column
  is implicitly NOT NULL with no explicit constraint; an un-backfillable staged row → atomic
  rejection (same underlying-unchanged assertion).
- **Happy path unchanged:** ADD COLUMN with a satisfiable per-row default over staged
  insert(s) succeeds and the staged rows carry the backfilled value through commit
  (read-your-writes), confirming the refactor of `deriveAddColumnBackfill` didn't regress the
  migrate path.
- **Regression guard:** existing ALTER tests in the spec (RENAME, etc.) still pass.

## Validation

- `yarn workspace @quereus/quereus-isolation test` (or `yarn test` from root) — streams via
  `2>&1 | tee /tmp/iso-test.log; tail -n 80 /tmp/iso-test.log`.
- `yarn workspace @quereus/quereus run lint` if the isolation package is covered; otherwise run
  the root build to typecheck the isolation package (`yarn build`).
- Do **not** run `yarn test:store` inline unless quick — the store path is exercised by the
  same `IsolationModule.alterTable` change only when a store underlying is wrapped, which these
  unit tests do not require; the logic is underlying-agnostic. Note any store deferral.

## TODO

- Refactor `deriveAddColumnBackfill(change, updatedSchema)` →
  `deriveAddColumnBackfill(change, db)` using `columnDefToSchema(change.columnDef,
  defaultNotNull)`; remove the `updatedSchema` dependency. Update its one caller in
  `migrateOverlayForAlter`.
- Add `validateOverlayMigration(oldState, addColumnCtx)` private method (tombstone-present
  guard + per-row dry-run via `computeAddColumnValue`).
- Call the dry-run for every `affected` overlay BEFORE `underlying.alterTable` in `alterTable`.
- Optionally factor the shared staged-row iteration helper if it reads cleanly.
- Add the tests above; run isolation tests + build/typecheck.
- Add a short note to `packages/quereus-isolation` docs/README (or the module-level comment on
  `alterTable`) stating the atomicity guarantee: ALTER through the isolation layer validates
  every overlay's backfill before mutating the shared underlying, so a backfill rejection leaves
  base + catalog untouched. Update the existing `alterTable` doc comment rather than adding a new
  doc.
