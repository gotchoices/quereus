description: ALTER TABLE ADD COLUMN with a DEFAULT must backfill the issuing connection's uncommitted overlay-staged rows, not hardcode NULL. `translateOverlayRow` currently appends a literal `null` for `addColumn`, dropping both literal defaults and per-row (`new.<column>`) defaults for staged rows.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## Problem

`IsolationModule.alterTable` (in
`packages/quereus-isolation/src/isolation-module.ts`) forwards the `SchemaChangeInfo`
to the underlying module — which correctly backfills *committed* rows (literal default
or per-row `backfillEvaluator`) — and then calls `migrateOverlayForAlter` →
`translateOverlayRow` to translate the connection's *uncommitted* overlay rows to the
post-ALTER column layout. For `addColumn` it appends a hardcoded `null`:

```ts
case 'addColumn':
    // New column is always appended after existing data columns.
    newData = [...data, null];
    break;
```

So a row staged (insert/update, not yet committed) by the same connection that issues
`ALTER TABLE … ADD COLUMN … DEFAULT (…)` ends up with `null` for the new column,
ignoring the DEFAULT entirely. This affects literal defaults too; the
`add-column-new-ref-backfill` work makes it sharper because each staged row should get
its *own* computed value, not a shared constant.

## Policy decision (resolved)

**ADD COLUMN mid-transaction with staged overlay rows is legal and the overlay rows are
backfilled** — it is NOT rejected. This is the consistent choice: `migrateOverlayForAlter`
already preserves staged rows across `dropColumn` and `renameColumn` (see
`translateOverlayRow`), so singling out `addColumn` for rejection would be incoherent. The
fix makes `addColumn` match committed-row backfill semantics.

## How committed rows are backfilled (the behavior to mirror)

The engine (`packages/quereus/src/runtime/emit/alter-table.ts`) puts two things on the
`SchemaChangeInfo` for `addColumn`:

- `change.columnDef` — the parsed column def; its DEFAULT constraint is
  `change.columnDef.constraints?.find(c => c.type === 'default')?.expr`.
- `change.backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>` — present
  **only** for a non-foldable DEFAULT (e.g. `new.<col>`). Given an existing row (the
  pre-ALTER column layout), it returns that row's value for the new column. Absent for a
  literal/NULL default (the module bulk-writes the folded constant).

The memory base layer (`packages/quereus/src/vtab/memory/layer/base.ts`
`recreatePrimaryTreeWithNewColumn`) and the store module
(`packages/quereus-store/src/common/store-module.ts` `addColumn` case) both do:
`value = backfillEvaluator ? await backfillEvaluator(oldRow) : foldedDefault`, where
`foldedDefault = tryFoldLiteral(defaultExpr) ?? null`. They also enforce NOT NULL on the
**evaluator path**: if the new column is NOT NULL and the evaluator yields `null` for a
row, they throw `StatusCode.CONSTRAINT`.

### Evaluator lifecycle — confirmed safe

`emit/alter-table.ts` installs the backfill's row slots and closes them in a `finally`
**after** `module.alterTable()` returns. `IsolationModule.alterTable` runs
`migrateOverlayForAlter` *inside* that same call, after
`await this.underlying.alterTable(...)`. Therefore `change.backfillEvaluator` is still
live when overlay rows are translated — calling it per overlay row is valid. Do not stash
it for later use.

## Required behavior

In the overlay migration, for `addColumn`, compute the new column's value per staged row
exactly as the committed path does:

- **Tombstone rows** (`oldRow[oldTombstoneIdx] === 1`, the deletion-marker convention used
  throughout `isolated-table.ts`): append `null`. A tombstone's data columns are mostly
  NULL placeholders (see `insertTombstoneForPK`), the appended value is never read, and
  running the evaluator against them could spuriously throw or reference NULL siblings.
- **Non-tombstone rows**:
  - `change.backfillEvaluator` present → `value = await change.backfillEvaluator(data)`,
    where `data` is the existing-columns slice (`oldRow.slice(0, oldTombstoneIdx)`), which
    matches the evaluator's expected row shape.
  - else → `value = foldedDefault` (the `tryFoldLiteral` of the DEFAULT expr, or `null`
    when there is no DEFAULT / it folds to NULL).
- **NOT NULL on the evaluator path**: if the new column is NOT NULL and the computed value
  is `null` for a non-tombstone row, throw `QuereusError(..., StatusCode.CONSTRAINT)`,
  mirroring `base.ts`. Resolve "is the new column NOT NULL" from the post-ALTER
  `updatedSchema` (the new column is the last entry in `updatedSchema.columns`).

`tryFoldLiteral` is exported from `@quereus/quereus` (already imported via
`@quereus/quereus` in this file — add it to the named imports).

## Suggested decomposition (keep functions small — AGENTS.md)

Precompute once per ALTER (outside the row loop) the folded literal default and the new
column's `notNull`, then compute the per-row value inside the `migrateOverlayForAlter`
loop and pass it into `translateOverlayRow`:

- Add an `addColumnValue?: SqlValue` parameter to `translateOverlayRow`; its `addColumn`
  case becomes `newData = [...data, addColumnValue ?? null]`. This keeps
  `translateOverlayRow` synchronous (the async evaluator call stays in the loop).
- In `migrateOverlayForAlter`, when `change.type === 'addColumn'`, derive
  `{ foldedDefault, evaluator, newColNotNull }` before the loop; per row, branch on
  tombstone / evaluator / literal as above, enforce NOT NULL, then call
  `translateOverlayRow(..., addColumnValue)`.
- Other `change.type`s pass `addColumnValue` as `undefined` — unchanged behavior.

Avoid `any`; type the new column lookup against `ColumnSchema`/`TableSchema` already in
scope.

## Edge cases & interactions

- **Literal default** (`ADD COLUMN c INTEGER DEFAULT 7`) on a staged row → staged row reads
  `7`, matching committed rows. (Today: `null`.)
- **Signed-numeric literal** (`DEFAULT -123.0`, a UnaryExpr) → folded by `tryFoldLiteral`,
  not dropped. Mirror the store path's note.
- **No default** (`ADD COLUMN c INTEGER`) → staged row reads `null`. The existing test
  "INSERT then ADD COLUMN: overlay row survives with NULL in new column" stays green.
- **Per-row `new.<col>` default** → each staged row computes its own value from its own
  data slice; two staged rows with different sibling values get different results.
- **Tombstone staged row** (a row the connection deleted in-txn, then ADD COLUMN) → appends
  `null`, evaluator NOT called, no spurious NOT NULL throw. After rollback the table is
  unchanged; after the ADD the tombstone still hides the underlying row at flush.
- **NOT NULL + per-row default yielding NULL** for a non-tombstone staged row → throws
  `CONSTRAINT`, consistent with committed rows.
- **NOT NULL + literal/NULL default**: gating already happens up-front in the engine
  (`emit/alter-table.ts` `validateNotNullBackfill`) / underlying before the overlay loop
  runs; the overlay path does not re-reject the literal case (only the evaluator case, per
  base.ts).
- **Partial-failure ordering (document, don't fix here):** `underlying.alterTable` runs and
  succeeds before the overlay loop. If a staged row trips the NOT NULL evaluator check, the
  overlay throw leaves the underlying already altered (its committed rows migrated) — the
  schema-catalog update is skipped by the engine but the underlying data tree is mutated.
  This pre-exists for any throw in `migrateOverlayForAlter` (e.g. the tombstone-column-missing
  INTERNAL throw) and is out of scope; note it in the review handoff.
- **Multiple overlays for one table** (multiple connections mid-txn): each affected overlay
  is migrated in the existing `affected` loop; the evaluator is per-row over each overlay's
  own staged rows. No cross-connection leakage.
- **Empty/changed overlay** (`hasChanges === false`): existing guard skips the row loop;
  unchanged.
- **Sequential ALTERs in one txn** (ADD then ADD/DROP/RENAME) must still round-trip the
  staged row through each migration.

## Tests

Add to the `ALTER TABLE overlay migration` describe block in
`packages/quereus-store/test/isolated-store.spec.ts` (sibling to the existing INSERT-then-
ADD/DROP/RENAME tests; this path exercises the isolation overlay regardless of underlying):

- **INSERT then ADD COLUMN with literal DEFAULT**: stage a row in a txn, `ALTER … ADD
  COLUMN score INTEGER DEFAULT 7`, read the staged row in-txn → `score === 7` (not null).
  Commit, re-read → still `7`. (Regression for the core bug.)
- **INSERT then ADD COLUMN with signed-literal DEFAULT** (`DEFAULT -5`) → staged row reads
  `-5`.
- **INSERT then ADD COLUMN with per-row `new.<col>` DEFAULT**: e.g. existing `qty` column,
  `ALTER … ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)`; stage two rows with different
  `qty`; each staged row's `qty2` is its own `qty*2`. Commit and confirm persisted values.
- **INSERT then ADD COLUMN NOT NULL with per-row default yielding NULL** → the ALTER throws
  a CONSTRAINT error (parallels the committed-row behavior).
- **DELETE (tombstone) then ADD COLUMN with DEFAULT**: stage a delete of an underlying row,
  ADD COLUMN with a default, confirm the ALTER does not throw and the deleted row stays
  deleted after the txn (in-txn read shows the row gone; the appended value is irrelevant).
- Keep the existing no-default test green (NULL when no DEFAULT).

Optionally add a memory-underlying analogue if a convenient harness exists in
`packages/quereus-isolation/test/isolation-layer.spec.ts`; the store-backed tests are the
primary coverage.

## TODO

- Add `tryFoldLiteral` to the `@quereus/quereus` named imports in `isolation-module.ts`.
- Extend `translateOverlayRow` with an `addColumnValue?: SqlValue` parameter; update its
  `addColumn` case and all call sites.
- In `migrateOverlayForAlter`, precompute folded default + new-column `notNull` for
  `addColumn`; compute per-row value (tombstone → null; evaluator → `await`; else literal)
  with NOT NULL enforcement on the evaluator path; pass into `translateOverlayRow`.
- Add the tests above to `packages/quereus-store/test/isolated-store.spec.ts`.
- Run `yarn test` (and `yarn workspace` for the quereus-store package) and `yarn lint` in
  `packages/quereus`; stream output with `tee` per AGENTS.md.
- Note the partial-failure ordering caveat in the review handoff.
