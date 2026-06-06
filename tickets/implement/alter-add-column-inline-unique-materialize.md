description: `ALTER TABLE … ADD COLUMN <col> … UNIQUE` (inline column-level UNIQUE on the new column) is silently dropped — neither materialized, enforced, nor rejected. Fix by routing the inline UNIQUE through the same module `addConstraint` UNIQUE path that `ALTER TABLE … ADD CONSTRAINT … UNIQUE` already uses (materialize + enforce + persist), symmetric with CREATE TABLE and ADD CONSTRAINT.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts            # runAddColumn: extracts CHECK + FK only (~line 286); add inline-UNIQUE handling; fix stale comment 286-287
  - packages/quereus/src/schema/constraint-builder.ts           # add extractColumnLevelUniqueConstraints (mirror extractColumnLevelCheckConstraints @112 / extractColumnLevelForeignKeys @136)
  - packages/quereus/src/vtab/memory/layer/manager.ts           # addConstraint UNIQUE arm (~line 2103/2127) — reused as-is, builds/reuses implicit covering index, throws CONSTRAINT on dup
  - packages/quereus-store/src/common/store-module.ts           # alterTable addConstraint UNIQUE arm (~line 869) — reused as-is, full-scan validate + saveTableDDL persist
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # Phase 24 verification gap (~line 562) — extend to assert round-trip once fixed
  - packages/quereus/test/alter-add-constraint.spec.ts          # sibling memory ADD CONSTRAINT UNIQUE tests to mirror
----

# Fix: materialize + enforce inline UNIQUE on ALTER TABLE ADD COLUMN

## Reproduction (confirmed)

Run against `main` (memory module) — duplicate is accepted, constraint absent:

```sql
create table T (id integer primary key);
alter table T add column u int unique;   -- accepted, no error
insert into T values (1, 5);             -- ok
insert into T values (2, 5);             -- ok (BUG) — duplicate u=5 accepted
select * from unique_constraint_info('T'); -- [] (BUG) — constraint does not exist
```

Verified via a throwaway mocha spec: `DUP_ERR: NONE (BUG - duplicate accepted)`,
`UCI: []`.

## Root cause

`runAddColumn` (`runtime/emit/alter-table.ts`) extracts only the new column's
**CHECK** (`extractColumnLevelCheckConstraints`) and **FOREIGN KEY**
(`extractColumnLevelForeignKeys`) inline constraints into the enhanced schema
(lines 288-289). There is **no** column-level UNIQUE extraction on this path. The
adjacent comment at 286-287 —

```
// Extract column-level CHECK / FK constraints. Column-level UNIQUE is not enforced via
// table-level constraints; the existing rejection path in the manager handles it.
```

— is wrong for this path: `manager.extractUniqueConstraints` is the **CREATE-time
schema-build** path (`buildTableSchemaFromAST`), never reached by the imperative
ADD COLUMN runtime. So the constraint is neither materialized, enforced, nor
rejected.

The asymmetry: CREATE TABLE inline UNIQUE materializes via
`extractUniqueConstraints`; `ALTER TABLE … ADD CONSTRAINT … UNIQUE` materializes
via `module.alterTable({type:'addConstraint', constraint})`. Only the ADD COLUMN
inline UNIQUE sub-path falls through.

## Chosen resolution — Option 1 (materialize + enforce)

Both built-in modules **already** implement the `addConstraint` UNIQUE arm with
full validation + persistence, so Option 1 is symmetric and requires no new
module work:

- **Memory** (`vtab/memory/layer/manager.ts` `addUniqueConstraint`): builds/reuses
  the implicit covering secondary index, throws `CONSTRAINT` on the first
  in-scope duplicate, surfaces via `unique_constraint_info`.
- **Store** (`quereus-store/.../store-module.ts` `alterTable` addConstraint arm):
  validates existing rows via `validateUniqueOverExistingRows`, appends to
  `uniqueConstraints`, and **persists** via `saveTableDDL`.

The fix converts each inline column-level UNIQUE into the equivalent table-level
`AST.TableConstraint` over the new column and feeds it to the same
`module.alterTable({type:'addConstraint', constraint})` call, **after** the
column is materialized (so the new column resolves in `columnIndexMap`).

## Integration point & ordering (chosen: early, right after addColumn)

Apply the inline UNIQUE(s) **immediately after** `module.alterTable(addColumn)`
returns `updatedTableSchema` (around alter-table.ts line 342) and **before** the
CHECK/FK merge and the first catalog write (`schema.addTable(validationSchema)`
at line 397). Each `addConstraint` call returns a schema carrying the new
column + the unique constraint (+ the memory covering index); use the last
returned schema as the new `updatedTableSchema` base, so the subsequent CHECK/FK
merge layers naturally on top — **no re-merge of engine-side CHECK/FK needed**
(the late-placement alternative would lose them, since the module is unaware of
engine-side CHECK/FK).

Atomicity / revert:

- On a UNIQUE failure (e.g. a literal `DEFAULT` backfills the same value to ≥2
  existing rows → immediate duplicate), the module's own `addConstraint` rolls
  back its internal schema and throws `CONSTRAINT`. Because the engine catalog
  has **not** been touched yet at this point (first `schema.addTable` is later at
  line 397), the runtime revert only needs to **drop the just-added column** from
  the module and rethrow — no catalog restore. Mirror the existing best-effort
  revert (`module.alterTable({type:'dropColumn'})` with a logged failure).
- Combined case (ADD COLUMN carrying BOTH a UNIQUE and a CHECK/FK that then
  fails existing-row validation): the existing CHECK/FK revert (`dropColumn` +
  restore original catalog at lines 430-442) must also tear down the unique
  covering index. `dropColumn` rebuilds the table without the column, which should
  drop a covering index over it — **verify with a test** (see TODO).

## Synthetic constraint shape

`buildUniqueConstraintSchema` (constraint-builder.ts) reads only `con.type`,
`con.columns[].name`, `con.name`, `con.onConflict`, `con.tags`. So the new
extractor emits, per inline `unique` ColumnDef constraint:

```ts
{
  type: 'unique',
  name: con.name,                       // preserve a named inline UNIQUE (round-trips)
  columns: [{ name: columnDef.name }],
  onConflict: con.onConflict,
  tags: con.tags,
}
```

`operations` is irrelevant for UNIQUE (not read by `buildUniqueConstraintSchema`)
— do not set it. Multiple inline `unique` constraints on one column each become
their own `addConstraint` call (rare, but handle the list like CHECK/FK do).

## Verification gap to close

`test/logic/50-metadata-tags.sqllogic` Phase 24 (~line 562) currently asserts the
ADD COLUMN inline UNIQUE's *tag* validation is accepted but deliberately does NOT
assert the constraint round-trips (because of this drop). Once fixed, assert the
round-trip there or in a dedicated logic test (runs under both memory **and**
store via `yarn test:store`).

## TODO

- [ ] Add `extractColumnLevelUniqueConstraints(columnDef: AST.ColumnDef): AST.TableConstraint[]` to `schema/constraint-builder.ts`, mirroring `extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys`. Emit the synthetic table-level UNIQUE shape above (preserve name/onConflict/tags).
- [ ] In `runAddColumn` (`runtime/emit/alter-table.ts`): after `module.alterTable(addColumn)` returns (before the CHECK/FK merge at ~line 350 and the first `schema.addTable` at line 397), extract inline UNIQUE(s) and apply each via `module.alterTable(rctx.db, schemaName, tableName, { type: 'addConstraint', constraint })`, threading the returned schema into `updatedTableSchema`. Wrap in try/catch that drops the just-added column and rethrows on failure (no catalog restore — catalog untouched at this point).
- [ ] Fix/remove the stale comment at `runtime/emit/alter-table.ts:286-287`.
- [ ] Logic test (memory + store) covering: (a) `add column u int unique` then duplicate insert rejected with `CONSTRAINT`; (b) `unique_constraint_info('T')` surfaces the constraint; (c) named inline UNIQUE round-trips its name; (d) two existing NULLs with no DEFAULT → add succeeds (NULLs distinct), forward duplicate still rejected.
- [ ] Test the literal-DEFAULT-over-non-empty-table case: `insert` ≥2 rows, then `alter table T add column u int default 5 unique` → fails `CONSTRAINT` and the column is reverted (absent from `pragma`/introspection, original schema intact).
- [ ] Test/verify the combined revert: ADD COLUMN with both a UNIQUE and a CHECK that fails existing-row validation → full revert tears down the unique covering index (no orphan in `index_info`).
- [ ] Update Phase 24 in `test/logic/50-metadata-tags.sqllogic` (or add a dedicated logic test) to assert the round-trip now that the drop is fixed.
- [ ] `yarn build && yarn test` (memory) and `yarn test:store` (store path) green; `yarn workspace @quereus/quereus lint`.
- [ ] If ALTER TABLE ADD COLUMN constraint coverage is documented (`docs/sql.md` / `docs/schema.md`), note that inline UNIQUE is now materialized.
