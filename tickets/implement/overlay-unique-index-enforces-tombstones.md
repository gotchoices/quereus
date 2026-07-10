---
description: Inside a transaction, deleting a row and inserting a different one can be wrongly rejected as a duplicate, because the deletion marker left behind is treated as if it were a real row by the unique-index check. The cause is found and a fix is already in the working tree; what remains is test coverage and docs.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # createOverlaySchema — the fix lives here (already applied)
  - packages/quereus-isolation/src/isolated-table.ts          # mergedSecondaryIndexQuery; insertTombstoneForPK; findMergedUniqueConflict
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # where the regression tests belong
  - packages/quereus/src/vtab/memory/layer/manager.ts         # checkSingleUniqueConstraint / checkUniqueViaIndex — honor the partial predicate
  - packages/quereus/src/vtab/memory/utils/predicate.ts       # compilePredicate — the AST forms a partial predicate may use
  - packages/quereus/src/schema/table.ts                      # IndexSchema.predicate, UniqueConstraintSchema.predicate
  - docs/design-isolation-layer.md                            # overlay/tombstone design doc
difficulty: easy
---

# Scope overlay indexes and UNIQUE constraints to live rows

## What was wrong

The isolation layer stages a connection's uncommitted writes in a private *overlay* table. A
deleted row is staged as a **tombstone**: the deleted row's primary key, `NULL` in every other
column, and a flag column marking it as a deletion.

`IsolationModule.createOverlaySchema` built the overlay's schema by copying the underlying
table's schema wholesale — including its secondary indexes and its `UNIQUE` constraints. The
overlay's storage therefore enforced uniqueness across *every* staged row and could not tell a
tombstone from a live row.

This was usually invisible: a tombstone is `NULL` in every non-primary-key column, and SQL
treats `NULL`s as distinct for uniqueness, so a `UNIQUE` structure over an ordinary column never
saw a tombstone as a duplicate. The luck ran out when every column of the `UNIQUE` structure sat
inside the primary key — tombstones carry real primary-key values, so two tombstones (or a
tombstone and a live row) collided.

Both reproductions from the original ticket were confirmed against `main` before the fix, using
`createIsolatedStoreModule`'s shape (an `IsolationModule` over a `MemoryTableModule`):

```sql
-- 1. spurious UNIQUE failure: "UNIQUE constraint failed: _overlay_t_2 (a)"
create table t (a integer, b integer, primary key (a, b));
create unique index t_a_ux on t (a);
insert into t values (1, 1);
begin;
  delete from t where a = 1 and b = 1;
  insert into t values (1, 2);   -- rejected before the fix

-- 2. INTERNAL out of the CREATE INDEX overlay rebuild
create table t (a integer, b integer, primary key (a, b));
insert into t values (1, 1);
insert into t values (1, 2);
begin;
  delete from t;
  create unique index t_a_ux on t (a);   -- INTERNAL before the fix
```

## The fix (already applied — verify, don't redo)

`createOverlaySchema` now narrows each copied index and each copied `UNIQUE` constraint into a
**partial** structure over live rows, by AND-ing `<tombstone column> = 0` onto whatever partial
predicate it already carried:

```ts
indexes: baseSchema.indexes?.map(idx => ({ ...idx, predicate: andPredicate(idx.predicate, liveOnly) })),
uniqueConstraints: baseSchema.uniqueConstraints?.map(uc => ({ ...uc, predicate: andPredicate(uc.predicate, liveOnly) })),
```

Why this is the right seam:

*   **Both arrays must be narrowed, not just `indexes`.** The memory module enforces uniqueness
    from `TableSchema.uniqueConstraints` (`MemoryTableManager.checkUniqueConstraints`), and
    `create unique index` synthesizes a matching `derivedFromIndex` unique constraint alongside
    the index (`appendIndexToTableSchema`). A table-level `unique (…)` declared at
    `create table` time produces a constraint with no index of its own; the manager auto-builds a
    covering `_uc_*` index for it and copies `uc.predicate` onto that index, so narrowing the
    constraint narrows its auto-index too. Narrowing only `indexes` would leave the
    `create table … unique (…)` case broken.
*   **`_tombstone = 0` is a legal partial predicate.** `compilePredicate` (memory module) handles
    `binary '='` over a column reference and a literal. The predicate is built as an AST rather
    than parsed from SQL text because the tombstone column name is host-configurable
    (`IsolationModuleConfig.tombstoneColumn`).
*   **Primary-key uniqueness is untouched.** The PK lives in `primaryKeyDefinition`, not in the
    copied `indexes`/`uniqueConstraints`, so it still covers tombstones — which is required, so a
    re-insert at a tombstoned PK is detected and converted into an overwrite
    (`IsolatedTable.insertTombstoneForPK` / `writeRelocatedRow`).
*   **The merged secondary-index scan already wanted this.** `IsolatedTable.mergedSecondaryIndexQuery`
    (the ticket called it `queryViaSecondaryIndex`) filters `row[tombstoneIndex] !== 1` out of the
    overlay's index scan by hand, and collects tombstoned PKs from a separate *full* scan. Removing
    tombstones from the index changes nothing it depends on.
*   **The merged UNIQUE check was never the problem.** `IsolatedTable.findMergedUniqueConflict`
    already skips underlying rows tombstoned in the overlay. Only the overlay's own storage-level
    enforcement judged tombstones as rows.

The `KNOWN DEFECT:` comment on `createOverlaySchema` has been removed and replaced with a comment
explaining the narrowing.

Validation already run with the fix in place:

| command | result |
| --- | --- |
| `yarn workspace @quereus/isolation run typecheck` | clean |
| `yarn workspace @quereus/isolation run test` | 194 passing |
| `yarn workspace @quereus/store run test` | 901 passing |
| `node packages/quereus/test-runner.mjs --store` | 6797 passing, 14 pending |

The store run covers `packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic` §4 and §5
(a newly created UNIQUE index must still be enforced against further writes in the same
transaction), which the original ticket named as the behavior that must not regress.

## What is left

Regression coverage. The fix is exercised today only by the existing suites, none of which reach
the delete-then-reinsert shape — the reason the defect survived. Every case below belongs in
`packages/quereus-isolation/test/isolation-layer.spec.ts` (an `IsolationModule` over a
`MemoryTableModule`, as its existing tests do), and every one must be asserted on its
*committed* result, not merely on "no error".

## TODO

- Confirm the working-tree change to `createOverlaySchema` (and the `andPredicate` /
  `liveRowPredicate` helpers below it) is present and reads correctly; do not re-derive it.

- Add regression tests to `packages/quereus-isolation/test/isolation-layer.spec.ts`:
  - **Delete-then-reinsert under a PK-covered UNIQUE index.** Reproduction 1 above. Assert the
    insert succeeds, the commit succeeds, and the table then holds exactly `(1, 2)`.
  - **`create unique index` inside a transaction over a fully tombstoned table.** Reproduction 2
    above. Assert the DDL succeeds, the commit succeeds, and the table is empty.
  - **Non-primary-key UNIQUE column.** Passes today (tombstone key is `NULL`); pin it so the fix
    cannot regress it. `create table t (a integer primary key, b integer)`,
    `create unique index t_b_ux on t (b)`, insert `(1, 1)`, then in a transaction delete `a = 1`
    and insert `(2, 1)`; commit; expect exactly `(2, 1)`.
  - **Pre-existing partial UNIQUE index.** The fix AND-s onto an existing predicate, a path
    nothing covers. Create `create unique index … on t (a) where b > 0`, and check both that a
    row outside the predicate's scope escapes enforcement and that a genuine in-scope duplicate
    staged inside a transaction is still rejected.
  - **Table-level `unique (…)` over PK columns**, declared at `create table` time (no explicit
    index) — the `uniqueConstraints` half of the fix. Same delete-then-reinsert shape as
    reproduction 1.
  - **Uniqueness still enforced inside the overlay.** Two live rows staged in one transaction
    that collide on a UNIQUE structure must still be rejected — narrowing must not have
    disabled enforcement. Cover both a UNIQUE index and a table-level `unique (…)`.
  - **PK reuse at a tombstoned key still detected.** Delete a row and re-insert at the *same*
    primary key inside the transaction; it must overwrite the tombstone and commit the new row
    (not raise, and not resurrect the old one). This pins the "PK uniqueness must keep covering
    tombstones" half of the design.
  - **Merged secondary-index scan.** With a non-unique index on a non-PK column, stage a delete
    and an update inside a transaction and read back through that index; the merged result must
    show neither the deleted row nor the stale pre-update value.

- Update `docs/design-isolation-layer.md`: the overlay-schema section (around the "Additional
  tombstone marker column" bullet, ~line 465) should state that the overlay's copied indexes and
  UNIQUE constraints are narrowed to live rows, and that the overlay's primary-key uniqueness
  deliberately is not.

- Run and report: `yarn workspace @quereus/isolation run test`, `yarn workspace @quereus/store run test`,
  `yarn test`, `yarn test:store` (~2 minutes), `yarn lint`.
