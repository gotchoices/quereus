description: Review of the fix making ALTER TABLE ADD COLUMN backfill the issuing connection's uncommitted overlay-staged rows from the column's DEFAULT (literal, signed-literal, or per-row `new.<col>`) instead of hardcoding NULL. Adversarially verify the per-row value computation, tombstone handling, NOT NULL enforcement, and the documented partial-failure ordering caveat.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What was implemented

`IsolationModule.migrateOverlayForAlter` (in
`packages/quereus-isolation/src/isolation-module.ts`) previously appended a hardcoded
`null` to every staged overlay row for `addColumn`, dropping both literal and per-row
DEFAULTs. It now backfills each staged row exactly as the committed path does
(`base.ts` `recreatePrimaryTreeWithNewColumn` / `store-module.ts` `migrateRows`).

Concrete changes:

- **Imports**: added `tryFoldLiteral` (value) and `ColumnSchema` (type) to the
  `@quereus/quereus` imports.
- **`AddColumnBackfillContext`** (new module-private interface): `foldedDefault`,
  `evaluator?`, `newColNotNull`, `newColName`, `tableName`.
- **`deriveAddColumnBackfill(change, updatedSchema)`**: precomputes the context once per
  ALTER. `foldedDefault = defaultExpr ? (tryFoldLiteral(defaultExpr) ?? null) : null`.
  The new column is resolved as the **last** entry of the post-ALTER `updatedSchema.columns`
  (notNull + name). Returns `undefined` for every non-`addColumn` change.
- **`computeAddColumnValue(ctx, oldRow, oldTombstoneIdx)`** (async, per row):
  - tombstone (`oldRow[oldTombstoneIdx] === 1`) → `null`, evaluator NOT called;
  - evaluator present → `await ctx.evaluator(oldRow.slice(0, oldTombstoneIdx))`, then throw
    `CONSTRAINT` if `newColNotNull && value === null` (evaluator path only — mirrors `base.ts`);
  - else → `ctx.foldedDefault`.
- **`translateOverlayRow`** gained an `addColumnValue: SqlValue | undefined` parameter; its
  `addColumn` case is now `[...data, addColumnValue ?? null]`. It stays synchronous (the
  async evaluator call lives in `migrateOverlayForAlter`'s row loop). Only call site updated.

Policy (from the plan, unchanged): ADD COLUMN mid-transaction with staged overlay rows is
**legal and backfilled**, not rejected — consistent with how `dropColumn`/`renameColumn`
already preserve staged rows.

## Behavior to verify (use cases)

- **Literal default** `ADD COLUMN score INTEGER DEFAULT 7` → staged row reads `7` in-txn and
  after commit (was `null`). Core regression.
- **Signed-literal default** `DEFAULT -5` (a UnaryExpr) → staged row reads `-5` (folded, not
  dropped to NULL).
- **Per-row default** `ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)` over two staged rows
  with different `qty` → each gets its own `qty*2`; persists across commit. Confirms the
  evaluator receives the correct pre-ALTER row slice.
- **NOT NULL + per-row default yielding NULL** for a non-tombstone staged row → ALTER throws
  `CONSTRAINT` (`not null` in the message). Parallels committed-row behavior.
- **Tombstone (DELETE) then ADD COLUMN with per-row NOT NULL default** → no spurious throw
  (evaluator skipped for the tombstone); the deleted row stays deleted in-txn.
- **No default** `ADD COLUMN c INTEGER` → staged row reads `null` (pre-existing test stays
  green).
- Falsy literal defaults (`0`, `''`, `false`) are preserved: `addColumnValue ?? null` and
  `tryFoldLiteral(...) ?? null` only coalesce null/undefined, never `0`/`''`/`false`.

## Tests added

Five tests in the `ALTER TABLE overlay migration` describe block of
`packages/quereus-store/test/isolated-store.spec.ts` (store-backed, exercises the isolation
overlay path):
1. literal DEFAULT 7 — in-txn + after commit;
2. signed-literal DEFAULT -5;
3. per-row `new.qty * 2` over two rows — in-txn + after commit;
4. NOT NULL + per-row default yielding NULL → throws CONSTRAINT;
5. tombstone + per-row NOT NULL default → no throw, row stays deleted.

Note: test 4 uses `val INTEGER NULL` because the engine's `default_column_nullability`
defaults to `not_null` (Third Manifesto) — a bare `val INTEGER` would reject the staged
`INSERT (1, NULL)` before the ALTER even runs.

## Validation performed

- `yarn workspace @quereus/store test` → **297 passing** (was 296+1-fail mid-implementation;
  the failure was a test-design issue — see test-4 note — not the code under test).
- `yarn workspace @quereus/isolation test` → **94 passing**.
- `yarn build:isolation` → clean (required: store tests consume the **built** `@quereus/isolation`
  dist, not source).
- `yarn test` (full workspace) → all suites green (engine 4849, isolation 94, store 297, sync
  163/45/121/…, plugins). The `Error:`/`boom` lines in the log are intentional fault-injection
  fixtures inside passing sync tests, not failures.
- `yarn workspace @quereus/quereus run lint` → clean. (Only the engine has a lint script; the
  isolation/store changes are not lint-covered.)

## Known gaps / caveats for the reviewer

- **Partial-failure ordering (documented, NOT fixed — out of scope).** `underlying.alterTable`
  runs and succeeds before the overlay loop. If a staged row trips the NOT NULL evaluator check
  (test 4), the overlay throw leaves the underlying already altered (its committed rows migrated)
  while the engine skips the schema-catalog update. This pre-exists for **any** throw in
  `migrateOverlayForAlter` (e.g. the tombstone-column-missing INTERNAL throw) and is not
  introduced by this change. If the reviewer judges it should be addressed, it is a separate
  fix/backlog ticket (underlying-alter rollback on overlay-migration failure), not an inline fix.
- **NOT NULL throw only on the evaluator path** — deliberately mirrors `base.ts`. The literal/
  NULL-default NOT-NULL case is gated up-front by the engine (`emit/alter-table.ts`
  `validateNotNullBackfill`) and by the underlying module before the overlay loop, so the overlay
  does not re-reject it. Verify this matches committed-row semantics and that no literal-default
  NOT NULL case slips through unguarded.
- **Evaluator liveness** relies on `emit/alter-table.ts` closing the backfill row slots in a
  `finally` *after* `module.alterTable()` returns, and `IsolationModule.alterTable` running
  `migrateOverlayForAlter` *inside* that call. Confirm this ordering still holds (the evaluator is
  called per overlay row, not stashed).
- **Evaluator row shape**: the slice `oldRow.slice(0, oldTombstoneIdx)` is passed as the
  pre-ALTER data row. Test 3 confirms `new.qty` resolves correctly, but the reviewer may want to
  confirm the shape holds for a composite/wider column set and for an overlay whose staged row was
  produced by an UPDATE (not just INSERT).
- **No memory-underlying analogue test** was added (the plan marked store-backed as primary
  coverage and the memory analogue as optional). If desired, an equivalent could be added to
  `packages/quereus-isolation/test/isolation-layer.spec.ts`.
- **Sequential ALTERs in one txn** (ADD then ADD/DROP/RENAME) are not directly asserted by a new
  test; the existing migration tests plus the per-change-type `translateOverlayRow` switch cover
  the round-trip, but a reviewer wanting belt-and-suspenders could add an ADD-then-DROP-in-one-txn
  case over a staged row.
