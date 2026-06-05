description: ADD COLUMN with a column-level FOREIGN KEY does not validate existing (backfilled) rows against the referenced parent — for any default kind. The FK is merged into the table-level constraint set for future INSERT/UPDATE only, so existing rows whose backfilled value has no matching parent are silently admitted.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus-store/src/common/store-table.ts
----

## Problem

`ALTER TABLE … ADD COLUMN c <type> REFERENCES parent(pk) [DEFAULT …]` merges the
new column-level FK into the table's `foreignKeys` set so future INSERT/UPDATE
enforce it (see `runAddColumn` in `runtime/emit/alter-table.ts`). But the
**existing rows** are never validated against the parent table:

- The literal-default path runs a post-`alterTable` scan that only checks CHECK
  constraints (`validateBackfillAgainstChecks`), not FKs.
- The per-row (non-foldable default) path enforces CHECK inside the backfill hook
  but does no FK lookup.

So adding a FK column whose backfilled value points at a non-existent parent row
is silently admitted on both the memory and store modules. This pre-dates the
CHECK-enforcement work (`alter-add-column-backfill-check-enforcement`) and is
independent of it.

## Expected behavior

Adding a column-level FK should validate existing rows against the referenced
parent the same way a future INSERT would — a backfilled value with no matching
parent row (and not NULL, per FK semantics) should abort the ALTER and leave the
table unchanged.

## Notes / approach hint

The per-row backfill hook introduced for CHECK enforcement is the natural place to
also evaluate the FK existence check per backfilled row (it already has the
freshly-computed value in hand and aborts mid-loop before any tree/batch swap, so
no extra rollback is needed). The literal-default path would need an analogous
post-scan FK existence query (mirroring `validateBackfillAgainstChecks`). A
FOLLOW-UP comment marking this gap already exists inline in `runAddColumn`.

Consider parent-NULL semantics (a NULL backfilled value satisfies the FK) and
match the write-time FK enforcement (synthetic NOT EXISTS check) so behavior is
consistent.
