---
description: PK-change UPDATE in `StoreTable.update` was leaking the moved row's old secondary-index entry because `updateSecondaryIndexes` used a single `pk` parameter for both the delete-old key and the put-new key. Fix splits the parameter; regression test added.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Bug

`updateSecondaryIndexes(oldRow, newRow, pk)` constructed both the delete-old index key and the put-new index key from the same `pk`. The PK-change UPDATE call site at `store-table.ts:780` passed `newPk`, so the delete step tried to remove `(oldRow_indexvals, newPk)` — an entry that did not exist. The real old entry, keyed by `oldPk`, was left behind, while the new entry at `(newRow_indexvals, newPk)` was written. Every PK-change UPDATE thus permanently leaked one secondary-index entry per index.

## Fix

`updateSecondaryIndexes` now takes `oldPk` and `newPk` with `newPk` defaulting to `oldPk`. The PK-change UPDATE call site passes both:

```ts
await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, oldPk, newPk);
```

The `if (oldRow)` branch keys the delete with `oldPk`; the `if (newRow)` branch keys the put with `newPk`. Insert/REPLACE, delete, and `deleteRowAt` callers are unchanged — they pass a single pk that fans out to both halves via the default.

## Test

Added a regression test in `column-default-conflict.spec.ts`: CREATE TABLE + CREATE INDEX, INSERT one row, UPDATE the PK to a new value. Iterates the index store and asserts exactly one entry remains (was 2 before the fix). A `SELECT … WHERE b = 100` confirms the surviving entry resolves to the relocated row.

## Validation

- `yarn workspace @quereus/store run test` → 262 passing.
- `yarn workspace @quereus/quereus run lint` → clean (quereus-store has no lint script).

## Review findings

**Correctness — fix is sound.** Re-derived the bug from the diff before reading the implementer's narrative: pre-fix, `updateSecondaryIndexes` keyed both halves off the same pk; the UPDATE site passed `newPk`, so the delete tried to remove an entry that never existed and left `(oldVals, oldPk)` behind. The split (`oldPk`, `newPk = oldPk`) maps each side to the right key. Default param keeps insert/delete callers terse without losing intent — appropriate for a 4-callsite helper, no churn elsewhere.

**Call-site audit (`find_references updateSecondaryIndexes`).** Four callers in `store-table.ts`:
- `:653` insert/REPLACE — `oldRow` (REPLACE) / `null` (INSERT) sit at the same pk; default is correct.
- `:782` PK-change UPDATE — now passes both pks, matches the bug fix.
- `:819` DELETE — `newRow=null`, so `newPk` default is unused.
- `:1042` `deleteRowAt` — `newRow=null`, same as above.
All four are right. No callers outside `store-table.ts`.

**Edge cases walked.** (1) Same-PK UPDATE with unchanged index value: oldPk == newPk; behavior identical to pre-fix. (2) PK-change UPDATE with unchanged index value: deletes `(vals, oldPk)`, puts `(vals, newPk)` — two distinct keys, both required. (3) PK-change UPDATE with changed index value: delete-old + put-new at fully different keys. (4) PK-change REPLACE that evicts a row at `newPk`: `deleteRowAt` runs first to clear the evictee's `(evictedVals, newPk)` entry, then the UPDATE deletes `(oldVals, oldPk)` and puts `(coercedVals, newPk)` — no overlap, correct ordering.

**Test coverage.** The added test exercises the actual bug (entry count = 1, not 2) and verifies the surviving entry resolves correctly via index-backed lookup. Coverage gaps that exist but don't affect the fix's parametric correctness: explicit BEGIN/COMMIT (transaction-coordinator branch is *already* exercised — Quereus auto-begins on DML, so `inTransaction=true` runs through the same path), multi-column PK, and tables with multiple secondary indexes. The fix loops over `schema.indexes` and treats every PK component identically, so the missing variants are mechanical replays. Not worth adding tests for.

**DRY / maintainability.** One helper still serves all four paths; the only complication is the defaulted second pk, which the JSDoc explains. No abstraction inflation.

**Resource cleanup / error handling.** Nothing in the fix's path allocates resources. Both halves still go through the existing `inTransaction ? coordinator : indexStore` branches; no error-handling surface changed.

**Type safety.** Both new params are `SqlValue[]`. Default value preserves variance.

**Docs.** No standalone StoreTable secondary-index doc. The function-level JSDoc was updated to explain why the two parameters exist; that's the right level for an internal helper. `docs/architecture.md` and `docs/optimizer.md` don't describe this implementation detail. Nothing to update.

**Lint + tests.** `yarn workspace @quereus/store run test` → 262 passing. `yarn workspace @quereus/quereus run lint` → clean.

**Adjacent code (out of scope, noted for future).** `MemoryTable`'s transaction-layer `recordUpdate` (`packages/quereus/src/vtab/memory/layer/transaction.ts:193+`) keeps a single `primaryKey` parameter for both `removeEntry(oldIndexKey, primaryKey)` and `addEntry(newIndexKey, primaryKey)`. Whether that path receives PK-change UPDATEs (vs. the upstream `recordUpdate` in `database-transaction.ts:541` which already splits PK-change into delete + insert) wasn't traced here — if it does, the same pattern of bug applies. Worth its own ticket if a logic test surfaces a leaked memory-vtab index entry; not in scope for this StoreTable fix.

**No major findings; no new tickets filed.**
