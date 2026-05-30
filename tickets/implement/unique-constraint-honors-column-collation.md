description: A table-level (or column-level inline) `unique(col)` over a column declared with a non-binary collation (e.g. `col text collate NOCASE`) is enforced with BINARY comparison rather than the column's declared collation. The auto-built UNIQUE index drops the column's collation, and the covering-MV / store / scan validators all re-compare with BINARY. Make all UNIQUE-enforcement paths honor the column's declared collation, on both the memory and store modules, including the row-time covering-MV path.
prereq:
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/src/util/comparison.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic
----

## Reproduced (memory module, `yarn test`)

A temporary `.sqllogic` block (removed) over the canonical (uppercase) collation
name confirmed the bug on both constraint spellings:

```sql
-- A: table-level unique() over a NOCASE column — BUG: both rows persist
create table ta (id integer primary key, x text collate NOCASE, unique(x));
insert into ta values (1, 'abc');
insert into ta values (2, 'ABC');   -- no conflict raised (BINARY enforcement)
select count(*) from ta;            -- => 2 (should be 1; the second should ABORT)

-- B: column-level inline unique over a NOCASE column — same BUG: 2 rows
create table tb (id integer primary key, x text collate NOCASE unique);
insert into tb values (1, 'abc');
insert into tb values (2, 'ABC');   -- no conflict raised
select count(*) from tb;            -- => 2

-- C (control): explicit CREATE UNIQUE INDEX over a NOCASE column — CORRECT
create table tc (id integer primary key, x text collate NOCASE);
create unique index tc_x on tc(x);
insert into tc values (1, 'abc');
insert into tc values (2, 'ABC');   -- correctly raises: UNIQUE constraint failed: tc (x)
```

Case C works because `SchemaManager.buildIndexSchema`
(`packages/quereus/src/schema/manager.ts:1409`) sets
`collation: indexedCol.collation || tableColSchema.collation`. Cases A and B go
through the auto-index synthesis, which omits it.

## Root cause

The auto-index synthesized for a UNIQUE constraint drops the column's collation,
and every *direct* comparison validator defaults to BINARY:

1. `MemoryTableManager.ensureUniqueConstraintIndexes`
   (`packages/quereus/src/vtab/memory/layer/manager.ts:165`) builds the auto-index as
   `columns: uc.columns.map(colIdx => ({ index: colIdx }))` — no `collation`.
   `MemoryIndex.createSingleColumnKeyFunctions` / `createCompositeColumnKeyFunctions`
   (`packages/quereus/src/vtab/memory/index.ts:82,103`) only apply a collation when
   the spec column carries `collation`; with none they default to BINARY. So the
   `checkUniqueViaIndex` path enforces BINARY.

2. `MemoryTableManager.checkUniqueViaMaterializedView`
   (`packages/quereus/src/vtab/memory/layer/manager.ts:1067`) re-validates candidates
   with `compareSqlValues(newRowData[col], conflictingRow[col])` — BINARY. (The
   candidate *generator* `lookupCoveringConflicts` is already collation-aware, but the
   validator re-match nets back to BINARY, so the covering-MV path is consistent with —
   not a regression over — the auto-index path. Both should honor collation together.)

3. `MemoryTableManager.checkUniqueByScanning`
   (`packages/quereus/src/vtab/memory/layer/manager.ts:1116`) — the cold fallback when
   no covering structure exists — also compares with BINARY.

4. Store `StoreTable.findUniqueConflict`
   (`packages/quereus-store/src/common/store-table.ts:1068`) compares with
   `compareSqlValues(newRow[idx], candidate[idx])` — BINARY. (The store has no
   secondary-index synthesis for non-PK UNIQUE; it scans, so there is no store
   analogue of `ensureUniqueConstraintIndexes` to fix — this comparison *is* the
   store equivalent.)

5. Store `StoreTable.findUniqueConflictViaCoveringMv`
   (`packages/quereus-store/src/common/store-table.ts:1119`) re-validates with
   `compareSqlValues(newRow[c], liveRow[c])` — BINARY.

`compareSqlValues(a, b, collationName)` (`packages/quereus/src/util/comparison.ts:214`)
already accepts a collation name (defaults `'BINARY'`), and `ColumnSchema.collation`
already carries the declared collation (defaults `'BINARY'`). The fix is to thread
`schema.columns[colIdx].collation` into the index spec and each comparison.

## Important side-finding — do NOT be misled by `102.1`

`packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic` (lines 4-25) asserts
that `email text collate nocase unique` / `unique (a, b)` with `a text collate nocase`
are **rejected at DDL** with `-- error: not supported`, and comments that "Quereus
does not support 'nocase' collation on TEXT columns in UNIQUE / index contexts." **That
comment is wrong / misleading.** Those statements use the *lowercase* spelling `nocase`,
and the rejection is actually an unrelated **case-sensitivity quirk**: `validateColumnSchema`
(`packages/quereus/src/schema/table.ts:191`) does
`!logicalType.supportedCollations.includes(constraint.collation)` against
`TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']`
(`packages/quereus/src/types/builtin-types.ts:112`) — a case-sensitive `includes`, so
lowercase `nocase` is rejected with a message that happens to contain "not supported".
With the canonical uppercase `NOCASE`, DDL succeeds and the UNIQUE silently enforces
BINARY (the bug above). UNIQUE-over-NOCASE is *not* an unsupported feature — it is a
soundness gap.

This case-sensitivity of the collation-name check is a **separate latent issue** (a
lowercase `collate nocase` column should be accepted and normalized). It is **out of
scope** here — do not fix collation-name normalization in this ticket; just be aware the
`102.1` blocks are asserting current behavior for the lowercase spelling. When adding
regression coverage, update the misleading `102.1` comment to explain the real cause and
that uppercase `NOCASE` UNIQUE now enforces case-insensitively (see TODO).

## Wanted

- The auto-built UNIQUE index carries each column's declared collation, so the
  `checkUniqueViaIndex` path enforces it.
- Every direct UNIQUE-conflict comparison (memory MV-validator, memory cold scan,
  store scan, store MV-validator) passes the column's collation to `compareSqlValues`.
- Behavior is identical across memory (`yarn test`) and store (`yarn test:store`),
  with and without a row-time covering MV.

## TODO

### Phase 1 — memory module
- In `ensureUniqueConstraintIndexes` (`manager.ts:165`), synthesize the auto-index
  columns with collation:
  `columns: uc.columns.map(colIdx => ({ index: colIdx, collation: this.tableSchema.columns[colIdx]?.collation }))`.
  (Leave the `matchingIndex` reuse branch as-is — an explicit index already carries its
  collation via `buildIndexSchema`.)
- In `checkUniqueViaMaterializedView` (`manager.ts:1067`), pass the column collation:
  `compareSqlValues(newRowData[col], conflictingRow[col], schema.columns[col].collation) === 0`.
- In `checkUniqueByScanning` (`manager.ts:1116`), same change:
  `compareSqlValues(newRowData[colIdx], existingRow[colIdx], schema.columns[colIdx].collation) === 0`.

### Phase 2 — store module
- In `StoreTable.findUniqueConflict` (`store-table.ts:1068`), pass the column
  collation: `compareSqlValues(newRow[idx], candidate[idx], schema.columns[idx].collation) !== 0`.
  (`schema` is `this.tableSchema!`, already bound at the top of `checkUniqueConstraints`.)
- In `StoreTable.findUniqueConflictViaCoveringMv` (`store-table.ts:1119`), same:
  `compareSqlValues(newRow[c], liveRow[c], this.tableSchema!.columns[c].collation) !== 0`.

### Phase 3 — regression tests
- Add a new logic file (memory + store, runs under both `yarn test` and
  `yarn test:store`), e.g. `packages/quereus/test/logic/102.2-unique-collation.sqllogic`,
  using the **canonical uppercase `NOCASE`** spelling. Cover:
  - table-level `unique(x)` over `x text collate NOCASE`: `insert 'abc'` then
    `insert 'ABC'` raises `UNIQUE constraint failed`; final row count is 1.
  - column-level inline `x text collate NOCASE unique`: same.
  - the same with an explicit row-time covering MV
    (`create materialized view ... as select x, id from t order by x`) so the
    covering-MV enforcement path is exercised (mirror the structure of
    `54-covering-mv-enforcement.sqllogic`).
  - `or ignore` / `or replace` interplay on a NOCASE duplicate (optional but valuable).
  - a non-colliding case-distinct-but-not-NOCASE-equal value still inserts (e.g.
    `'abc'` vs `'abd'`), to guard against over-matching.
  - a `collate RTRIM` UNIQUE rejecting a trailing-space duplicate (optional second
    collation to prove generality).
- Fix the misleading comment + (if appropriate) the assertions in
  `102.1-unique-edge-cases.sqllogic` lines 4-25: explain the rejection of lowercase
  `nocase` is a collation-name case-sensitivity quirk (not "UNIQUE doesn't support
  collation"), and that uppercase `NOCASE` UNIQUE now enforces case-insensitively. Keep
  the lowercase-`nocase` `-- error: not supported` blocks (they still reflect current
  behavior) but correct the surrounding prose.

### Phase 4 — validate
- `yarn workspace @quereus/quereus run build` (or `yarn build`) to typecheck.
- `yarn test` (memory) — full suite; confirm the new file passes and nothing regresses.
- `yarn test:store` — confirm the new file passes under the store path too (this is the
  path that actually exercises `store-table.ts` changes).
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).

## Notes
- Scope is broader than the covering-MV feature; this is a pre-existing soundness gap
  discovered while reviewing `covering-structure-mv-rowtime-enforcement`.
- Do **not** fix collation-name case-insensitivity here (the lowercase-`nocase` rejection)
  — that is a separate concern; file a backlog ticket if desired, but it is not required
  for this fix.
- `compareSqlValues` defaults the collation arg to `'BINARY'` and `ColumnSchema.collation`
  defaults to `'BINARY'`, so threading the column collation is safe for binary columns
  (no behavior change there).
