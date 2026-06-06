description: ALTER TABLE ADD COLUMN now backfills the issuing connection's uncommitted overlay-staged rows from the column's DEFAULT (literal, signed-literal, or per-row `new.<col>`) instead of hardcoding NULL — matching the committed-row path. Reviewed and completed.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What shipped

`IsolationModule.migrateOverlayForAlter` (packages/quereus-isolation/src/isolation-module.ts)
previously appended a hardcoded `null` to every staged overlay row for `addColumn`, dropping
both literal and per-row DEFAULTs. It now backfills each staged row exactly as the committed
path does (`base.ts` `recreatePrimaryTreeWithNewColumn`, `store-module.ts` `migrateRows`):

- **`deriveAddColumnBackfill(change, updatedSchema)`** precomputes per-ALTER constants once:
  the folded literal default (`tryFoldLiteral(defaultExpr) ?? null`), the engine-supplied
  per-row evaluator (`change.backfillEvaluator`, present only for a non-foldable `new.<col>`
  default), and the new column's NOT NULL flag / name (resolved as the last column of the
  post-ALTER schema). Returns `undefined` for every non-`addColumn` change.
- **`computeAddColumnValue(ctx, oldRow, oldTombstoneIdx)`** computes one staged row's value:
  tombstone → `null` (evaluator skipped); evaluator present → `await evaluator(dataSlice)`
  with a `CONSTRAINT` throw when `notNull && value === null` (evaluator path only); else the
  folded literal default.
- **`translateOverlayRow`** gained an `addColumnValue` parameter and stays synchronous (the
  async evaluator call lives in the caller's row loop).

Policy unchanged: ADD COLUMN mid-transaction with staged overlay rows is legal and
backfilled, consistent with how dropColumn/renameColumn already preserve staged rows.

## Review findings

**Diff reviewed first, fresh, before the handoff summary** (`git show acde49b2`).

### Correctness — faithful mirror of the committed path (verified)
- Compared `computeAddColumnValue` against `base.ts` `recreatePrimaryTreeWithNewColumn` and
  `store-module.ts` `migrateRows`: tombstone-skip, evaluator-derived value, NOT-NULL-on-
  evaluator-path-only, and literal-default fallback all match. `tryFoldLiteral` semantics
  (undefined → non-foldable, null → folds-to-NULL) are handled correctly; signed-literal
  (UnaryExpr) defaults fold.
- **Overlay row shape verified**: `createOverlaySchema` appends the tombstone as the *last*
  column, so `oldRow.slice(0, oldTombstoneIdx)` is exactly the data columns and there are no
  columns after the tombstone — the `slice` and the `[...newData, tombstoneValue]` re-append
  are correct.
- **NOT NULL gating hole checked and cleared**: the literal/NULL-default NOT NULL case is not
  re-checked in the overlay loop; it relies on the engine's `validateNotNullBackfill`
  (runtime/emit/alter-table.ts). That gate runs `select 1 from <table> limit 1` *through the
  isolation layer*, so it sees staged inserts (read-your-writes) and rejects up-front.
  Confirmed `IsolationModule.getCapabilities` only spreads underlying caps and store/memory
  leave `delegatesNotNullBackfill` off, so the engine gate is not skipped for isolated tables.
- **Evaluator liveness verified**: `migrateOverlayForAlter` runs *inside*
  `IsolationModule.alterTable` (the `module.alterTable()` call), and `emit/alter-table.ts`
  closes the backfill row slots in a `finally` only *after* that returns — so the per-row
  evaluator's slot is live for every overlay row.

### Type safety / DRY / cleanup
- `change` is narrowed to the `addColumn` variant before `columnDef` access; no `any` leaks
  in the new code. No new resources allocated beyond the already-managed overlay table. The
  precompute-once / branch-per-row split is clean and well-commented. Nothing to fix.

### Tests — implementer's 5 are a sound starting point; added 2 for claimed-but-untested behavior
Implementer added (store-backed, in `ALTER TABLE overlay migration`): literal DEFAULT 7,
signed-literal DEFAULT -5, per-row `new.qty*2` over two staged INSERTs, NOT NULL + per-row
default → CONSTRAINT, tombstone + per-row NOT NULL → no throw. All meaningful and passing.

**Added inline (minor) — 2 tests** in `packages/quereus-store/test/isolated-store.spec.ts`:
- *falsy literal `DEFAULT 0`* → staged row reads `0`, not NULL. Guards the
  `addColumnValue ?? null` / `tryFoldLiteral(...) ?? null` nullish-coalescing — the exact
  spot a `|| null` regression would corrupt a legitimate falsy default. Was claimed in the
  handoff but untested.
- *UPDATE-staged row + per-row `new.qty*2`* → evaluator sees the staged (updated) value
  (qty 100 → qty2 200), not the committed one (10 → 20). The implementer's per-row test only
  covered INSERT-staged rows; this covers the read-your-writes UPDATE-overlay interaction
  the handoff flagged as an untested gap. Asserted in-txn and after commit.

### Docs
Checked all `**/*.md` and the isolation package: no user-facing or architecture doc described
the old NULL-backfill behavior, so nothing was stale. The behavior is documented via the
JSDoc on the new methods, which is accurate. No doc changes needed.

### Major finding → filed as backlog, not fixed inline
- **Mid-transaction ALTER partial-failure is not atomic** (pre-existing, architectural).
  `underlying.alterTable` mutates the *shared* base immediately; a subsequent throw in
  `migrateOverlayForAlter` (the new NOT NULL evaluator check, or the pre-existing
  tombstone-missing INTERNAL guard) leaves the underlying altered while the engine skips the
  catalog update. This predates this change — the fix only adds one more throw site that
  mirrors committed-row semantics — and a correct fix needs design (pre-validate the overlay
  backfill before mutating the underlying, expose an inverse, or stage DDL). Filed as
  `tickets/backlog/alter-partial-failure-underlying-not-reverted.md`.

### Not pursued (explicitly, with reason)
- *Memory-underlying analogue test* — the plan marked store-backed as primary coverage; the
  store path exercises the identical isolation overlay code, so a memory duplicate adds little.
- *Sequential ALTERs in one txn (ADD then DROP/RENAME)* — each change type round-trips through
  the same `translateOverlayRow` switch already covered by existing per-type migration tests;
  no shared mutable state couples them, so a combined case is belt-and-suspenders, not a gap.

## Validation performed
- `yarn build:isolation` → exit 0 (store tests consume built isolation dist).
- `yarn workspace @quereus/store test` → **299 passing** (297 + the 2 added), exit 0.
- `yarn workspace @quereus/isolation test` → **94 passing**, exit 0.
- `yarn workspace @quereus/quereus run lint` → clean, exit 0.

The `boom` / "THIS IS NOT VALID SQL" lines in the store log are intentional fault-injection
fixtures inside passing tests, not failures.
