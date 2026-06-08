description: FK CHECK constraint (_fk_ref_child_parent_id) fires at COMMIT under the store module for valid references
files:
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## Summary

Resolved by dependency `store-transaction-isolation-and-rollback` (now in `complete/`).

The root cause was a read-visibility gap under the store module: deferred FK constraint evaluators (in `deferred-constraint-queue.ts`) queried the parent table via the normal read path, which did not see the transaction's own pending writes. A CASCADE UPDATE would write `parent_id 1→10` into the write buffer, but the FK evaluator would query for `id = 10` and find nothing — triggering a false `CHECK constraint failed: _fk_ref_child_parent_id`.

Once `store-transaction-isolation-and-rollback` landed an overlay that makes vtab reads see their own transaction's writes, the evaluator's read naturally went through that overlay and found the cascaded row. No secondary fix was needed in the constraint evaluation path.

## Validation

`yarn test:store` — 2436 passing, 0 failures (2026-05-01).

The failing scenario (`41-foreign-keys.sqllogic:195-221` CASCADE UPDATE under `QUEREUS_TEST_STORE=true`) now passes.
