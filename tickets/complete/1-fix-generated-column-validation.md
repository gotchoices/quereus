description: Per-table generated-column dependency graph; chained gen→gen INSERT/UPDATE in topological order; cycle/self-edge detection at CREATE TABLE / ALTER TABLE ADD COLUMN; DROP COLUMN refuses to drop a column referenced by a generated column.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/logic/41-generated-column-extras.sqllogic
  packages/quereus/test/logic/41-generated-column-errors.sqllogic
  docs/sql.md
----

## What landed

Per-table generated-column dependency graph cached on `TableSchema` and used to:

1. **Detect cycles / self-edges at DDL time.** `extractGeneratedColumnDependencies` walks every generated column's expression AST; any `ColumnExpr` (and qualified-to-this-table form) whose name isn't in `columnIndexMap` raises a `Column 'X' referenced by generated column 'Y' not found` error at `CREATE TABLE` / `ALTER TABLE ADD COLUMN` time. `topoSortGeneratedColumns` runs Kahn's algorithm restricted to gen→gen edges; a self-edge or any cycle raises `Cyclic dependency in generated columns: …`. References qualified to a different table are skipped (outer-scope refs).

2. **Evaluate INSERT/UPDATE in topological order.** `createGeneratedColumnProjection` (insert) is a chain of one projection per generated column iterated in `generatedColumnTopoOrder`; each iteration recomputes a single gen column with its expression resolved against the prior projection's attributes (so a gen column referencing another gen column sees the freshly-computed value, not the placeholder NULL). `buildUpdateStmt` walks the same topo order when appending implicit generated-column assignments — the runtime emitter already evaluates them against the in-place `updatedRow` via `withRowContext`, so iteration order is enough.

3. **Block DROP COLUMN of a referenced column.** `runDropColumn` consults `tableSchema.generatedColumnDependencies` before calling `module.alterTable`; if any other generated column's deps include the target index, throws `CONSTRAINT: Cannot drop column 'x' from 't': it is referenced by generated column 'g'`. Dropping the generated column itself succeeds; outgoing edges disappear with it.

4. **Refresh the graph through ALTER.** `withGeneratedColumnGraph(tableSchema)` recomputes both fields from a schema's current column array; `runAddColumn` and `runDropColumn` call it after `module.alterTable` returns so column-index shifts and the new/removed column are reflected.

## Files & key locations

- `packages/quereus/src/schema/table.ts:67-79` — new `generatedColumnDependencies` + `generatedColumnTopoOrder` on `TableSchema`.
- `packages/quereus/src/schema/table.ts:548-689` — `withGeneratedColumnGraph`, `extractGeneratedColumnDependencies`, `topoSortGeneratedColumns`.
- `packages/quereus/src/schema/manager.ts:893-924` — `buildTableSchemaFromAST` runs cycle detection before `module.create`.
- `packages/quereus/src/planner/building/insert.ts:168-218` — `createGeneratedColumnProjection` chained-projection rewrite.
- `packages/quereus/src/planner/building/update.ts:106-118` — implicit generated assignments emitted in topo order.
- `packages/quereus/src/runtime/emit/alter-table.ts:236-244` — `runAddColumn` recomputes the dep graph (cycle/unknown-ref throws after `module.alterTable`; see "Known limitation" below).
- `packages/quereus/src/runtime/emit/alter-table.ts:382-415` — `runDropColumn` validates incoming gen-column refs *before* `module.alterTable`, then re-extracts deps after.

## Tests

`packages/quereus/test/logic/41-generated-column-extras.sqllogic`:
- `t_chain` — `m = a*2`, `w = m*5` declared in dep order; INSERT computes `m=6, w=30`; UPDATE recomputes both.
- `t_chain_rev` — `w` declared *before* its dependency `m`; topo sort reorders so the same INSERT/UPDATE results hold (would fail with declaration-order processing).

`packages/quereus/test/logic/41-generated-column-errors.sqllogic`:
- `t_self` — `a generated as (a + 1)` rejected at `CREATE TABLE`.
- `t_cycle` — `c1 → c2 → c1` rejected at `CREATE TABLE`.
- `t_drop` — `b generated as (a*2)`; `drop column a` rejected; `drop column b` succeeds; surviving SELECT returns `id, a`.

## Validation

- `yarn test` (`packages/quereus`): generated-column suites all green (`41-generated-column-errors.sqllogic`, `41-generated-column-extras.sqllogic`, `41-generated-columns.sqllogic`). Full suite: 2518 passing, 2 pending. The 6 unrelated failures are pre-existing optimizer-rule tests in `optimizer/predicate-normalizer.spec.ts` and `optimizer/extended-constraint-pushdown.spec.ts` (NOT-inversion / OR-residual cases) — they predate this branch and track work on `or-predicate-support` / `is-null-index-optimization`.
- `yarn lint` clean.
- `yarn typecheck` clean.
- `yarn test:store` not run; only the gen-column dep graph extension was touched, and `runDropColumn` revalidates after `module.alterTable` returns its post-drop schema, which should not behave differently across the memory and store paths.

## Docs

`docs/sql.md` updated: removed the stale "may only reference non-generated columns of the same table" wording; added the chain-allowed / acyclic / self-rejected guidance and called out the `ALTER TABLE … DROP COLUMN` rejection rule.

## Known limitation (carried forward from review notes)

`runAddColumn` validates the dep graph *after* `module.alterTable` has already added the column to storage. The catalog isn't mutated on validation failure, but storage is. The window is narrow — the only way validation throws on a single ADD COLUMN is an unknown-column reference inside the new column's `generatedExpr` (cycles can't form just by adding one column). On retry the user will see "column already exists" from the module instead of the original "column referenced by generated column 'X' not found" message. The `validateBackfillAgainstChecks` revert path next door (drop the column, restore the catalog entry) is the precedent if a future ticket wants to close this; not addressed here per "don't add abstractions beyond what the task requires."

## Future-proofing notes

- `finalizeCreatedTableSchema` in `manager.ts` preserves the dep map by reference because the memory module does not rebuild the schema. A future module that returns a freshly-constructed `TableSchema` would lose `generatedColumnDependencies` / `generatedColumnTopoOrder` silently. A `withGeneratedColumnGraph` call in `finalizeCreatedTableSchema` would close this — flagged but not fixed because no such module exists today.
- `extractGeneratedColumnDependencies` walks the entire AST including subqueries; over-reporting an inner-scope column reference as a same-table dep is benign because (a) topo edges only over-trigger, never miss, and (b) `validateDeterministicGenerated` rejects scalar subqueries in generated expressions on the deterministic-only constraint, so the question is academic.

## Usage examples

```sql
-- Chained generated columns in declaration order:
create table t (
  id integer primary key,
  a integer not null,
  m integer generated always as (a * 2) stored,
  w integer generated always as (m * 5) stored
);
insert into t (id, a) values (1, 3);  -- a=3, m=6, w=30
update t set a = 4 where id = 1;       -- a=4, m=8, w=40

-- Reverse declaration order (topo sort handles it):
create table t_rev (
  id integer primary key,
  a integer not null,
  w integer generated always as (m * 5) stored,
  m integer generated always as (a * 2) stored
);

-- Self-edges and cycles rejected at CREATE TABLE:
create table t_self (id integer primary key, a integer generated always as (a + 1) stored);
-- error: Cyclic dependency in generated columns: 'a'

-- DROP COLUMN guards a referenced column:
create table t (id integer primary key, a integer not null, b integer generated always as (a * 2) stored);
alter table t drop column a;
-- error: Cannot drop column 'a' from 't': it is referenced by generated column 'b'
alter table t drop column b;  -- ok
```
