---
description: Tightening a column to NOT NULL inside a transaction now sees the rows that transaction just wrote — a pending NULL rejects the ALTER (or is backfilled from the column's DEFAULT) instead of being silently ignored. Fixed on the memory backend, the store backend, and through the isolation overlay.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # setNotNull arm + valueConvert/convertNulls seam
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # convertColumn convertNulls param
  - packages/quereus-store/src/common/store-module.ts            # alterColumnSetNotNull threads `rows`
  - packages/quereus-isolation/src/isolation-module.ts           # SetNotNullBackfillContext + derive/validate/translate seam
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts  # memory coverage (+12 tests)
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # issuer overlay coverage (+3)
  - packages/quereus-isolation/test/isolation-layer.spec.ts      # foreign overlay poison/backfill (+3, white-box)
  - packages/quereus-store/test/isolated-store.spec.ts           # store-behind-isolation coverage (+3)
  - docs/memory-table.md                                          # § DDL and transactions
difficulty: hard
---

# `alter column … set not null` now sees the transaction's own rows

## What was wrong

`ALTER TABLE … ALTER COLUMN … SET NOT NULL` decided reject-vs-backfill by scanning only
**committed** rows, ignoring the issuing transaction's own uncommitted writes. So this was wrongly
**accepted**, leaving a NULL under a `NOT NULL` column:

```sql
create table t (id integer primary key, v text null);
begin;
insert into t values (1, null);
alter table t alter column v set not null;   -- should reject with CONSTRAINT; was accepted
```

Three storage layers each ignored the pending rows independently. All three are fixed, mirroring the
already-landed `set data type` fix (memory) and the UNIQUE-DDL overlay fix (isolation).

## What changed, per layer

### Memory backend (`manager.ts` `alterColumn` setNotNull arm, + `transaction.ts`)
- The NULL scan now walks the **effective view** (`rows ? rows() : effectiveDdlRows()`), exactly like
  the `set data type` arm — a pending NULL rejects, a pending-deleted NULL does not block.
- Backfill (usable literal `DEFAULT`) was rerouted off the old in-place `tree.upsert` onto the
  **same base-replacement + open-layer conversion seam** `set data type` uses. Introduced a
  `convertNulls` flag on `convertBaseRows` / `TransactionLayer.convertColumn` so the value map
  `null → DEFAULT` reaches NULL cells (the converter otherwise skips NULLs). The old
  `valuesRewritten` in-place branch was retired. This is what fills the transaction's **own pending**
  NULL rows (they live in the pending layer, not the base) and avoids `MutatedBaseError`.
- Local variable `typeConvert` was renamed `valueConvert` (it now serves both arms).

### Store backend (`store-module.ts` `alterColumnSetNotNull`)
- Now receives the isolation-supplied `rows`. When present, the reject-vs-backfill decision scans
  `rows()` (the overlay) instead of `table.rowsWithNullAtIndex` (committed store only). The
  committed-store `mapRowsAtIndex` backfill is unchanged; overlay-resident pending rows are the
  isolation layer's job.

### Isolation layer (`isolation-module.ts`)
- New `SetNotNullBackfillContext` + `deriveSetNotNullBackfill` (column index + folded DEFAULT +
  has-default flag), parallel to `AddColumnBackfillContext`/`deriveAddColumnBackfill`.
- `translateOverlayRow` backfills a staged NULL at the column (`null → DEFAULT`) for the with-DEFAULT
  case — filling the issuer's own overlay rows.
- `validateOverlayMigration` rejects a staged NULL with no usable DEFAULT: for the **issuer** this
  aborts atomically before the underlying mutates; for a **foreign** overlay the caller maps it to
  **poison** (same tiering `add column … not null` already uses).
- `buildAlterPoisonMessage` extended to name the `set not null` column.

## Expected behavior (all verified by tests)

- A NULL in any row the transaction can see (committed **or** its own pending) → `CONSTRAINT`, nothing
  mutated, transaction stays usable.
- A NULL only in a row the transaction has deleted → does **not** block.
- Usable literal `DEFAULT` → those rows (committed + pending/overlay) are backfilled instead.
- Foreign connection's overlay: backfilled if a DEFAULT exists, else poisoned (its next
  read/write/commit throws); the issuer's ALTER still applies.

## How to test / validate

Build + suites all green this run:
- `yarn test` — full workspace (memory + wrapped legs). Memory cases live in
  `test/ddl-in-transaction-validation.spec.ts` → "alter column … set not null sees the transaction's
  own rows" (12 cases: pending-only reject, pending-vs-committed, pending-deleted accept, DEFAULT
  backfill of pending/committed, later-NULL-insert enforcement, savepoint layers, autocommit,
  secondary-index re-resolution).
- Isolation: `packages/quereus-isolation/test/…` — issuer reject + issuer DEFAULT-backfill
  (conformance spec, `db.exec` path) and foreign-overlay poison / atomic issuer reject / foreign
  DEFAULT-backfill (isolation-layer white-box, `iso.alterTable`).
- Store-behind-isolation: `packages/quereus-store/test/isolated-store.spec.ts` → "mid-transaction SET
  NOT NULL over staged overlay rows" (overlay-only reject, DEFAULT backfill, committed-NULL-through-
  overlay reject) — drives engine → isolation → store, exercising the store's new `rows` branch.

Single-file reruns (from repo root):
```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/ddl-in-transaction-validation.spec.ts --reporter dot
node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js packages/quereus-isolation/test/alter-table-conformance.spec.ts packages/quereus-isolation/test/isolation-layer.spec.ts --reporter dot
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js packages/quereus-store/test/isolated-store.spec.ts --reporter dot
```
`yarn workspace @quereus/quereus run lint` clean (eslint + tsc of quereus test files).

## Known gaps / where the reviewer should push

- **`set data type` behind the isolation overlay is still an open gap** (out of scope here, as the
  source ticket directed). The issuer/foreign overlay rows are not converted — `deriveSetNotNullBackfill`
  / `translateOverlayRow` / `validateOverlayMigration` are the exact seam a later ticket would extend
  with a parallel `SetDataTypeBackfillContext`. Left as greppable `NOTE:` markers at the
  `SetNotNullBackfillContext` interface doc and in `translateOverlayRow`'s `alterColumn` case — **not**
  filed as a ticket (a tripwire pointer, per workflow rules). Worth confirming that pointer is where a
  future implementer would actually look.
- **DEFAULT-literal detection is asymmetric and pre-existing**: memory uses `tryFoldLiteral` (folds
  e.g. `1+1`), store uses a strict `expr.type === 'literal'`. I preserved both rather than unify. A
  `SET NOT NULL` with a foldable-but-non-literal DEFAULT would backfill on memory and reject on store.
  Not exercised by tests; decide whether that divergence deserves its own ticket.
- **Isolation white-box tests use `MemoryTableModule` as the underlying** (the harness's convention),
  so the *store*-behind-isolation path is covered separately by `isolated-store.spec.ts` rather than in
  the same white-box matrix. Reviewer may want the foreign-overlay poison case exercised against a real
  store too (heavier; not added).
- **Isolation/store test files are `tsconfig`-excluded** (type-stripped at runtime, project
  convention), so their types are not CI-gated — only `packages/quereus` lint type-checks its own test
  files. My additions follow existing patterns and run green, but a type slip in the wrapped-package
  tests would not be caught by a build. Consider whether that convention should change.
- **Secondary-index rebuild on backfill rebuilds *every* index** (memory `rebuildPrimaryTreeFromRows`),
  not just those covering the column — same tradeoff `set data type` already makes. Fine now; a
  `NOTE:` tripwire for this already exists on the sibling path.
- The memory catch-block comment still says "or from setNotNull's NULL scan" — accurate (the scan
  still exists, now over the effective view). Confirm the atomicity reasoning there still reads right
  after the refactor.
