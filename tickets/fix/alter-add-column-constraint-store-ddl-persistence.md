description: ALTER TABLE ADD COLUMN ... REFERENCES/CHECK loses the column-level FK and CHECK on store reload. The store module's addColumn persists DDL from a schema that omits the engine-merged column-level constraints, so after rehydrateCatalog the constraint is gone and orphan/violating inserts are accepted. Pre-existing (from alter-add-column-backfill-fk-enforcement); orthogonal to the anti-join fold fix.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## Symptom

In store mode, after:

```sql
create table p (pid integer primary key) using store;
create table c (id integer primary key) using store;
insert into p values (1);
insert into c values (10);
alter table c add column pref integer default 1 references p(pid);
```

the column `pref` survives a reopen (`rehydrateCatalog`) but the **FOREIGN KEY does
not** — an orphan `insert into c values (20, 99)` is **accepted** after reopen
(confirmed via a temporary probe in `rehydrate-catalog.spec.ts`). The same applies to a
column-level **CHECK** added via `ADD COLUMN`: it is enforced in the live (pre-reopen)
session but lost from the persisted DDL.

## Root cause

Column-level FK/CHECK extraction and merge for `ADD COLUMN` lives in the **engine emit
layer** (`runtime/emit/alter-table.ts`): `extractColumnLevelForeignKeys` /
`extractColumnLevelCheckConstraints` build the constraints, which are merged into
`enhancedTableSchema` and registered into the in-memory `SchemaManager`. The **store
module never sees** that merged schema.

The store's `alterTable` addColumn arm (`store-module.ts`, ~line 648) builds its own
`updatedSchema = { ...oldSchema, columns, columnIndexMap }` — appending only the column —
and persists it via `saveTableDDL(updatedSchema)` (which serializes through
`generateTableDDL`). Because `updatedSchema` carries neither the new FK nor the new CHECK,
the persisted catalog DDL omits them. On `rehydrateCatalog`, the table is reconstructed
from that DDL without the constraint.

Contrast: `ADD CONSTRAINT` works correctly because the store's `addConstraint` arm
explicitly builds the FK/UNIQUE into `updatedSchema` and persists it (and the engine FK
existing-row validation also runs there). `ADD COLUMN` has no equivalent constraint
plumbing into the store's persisted schema.

Memory mode is unaffected — it has no persistence layer; the in-memory SchemaManager holds
the merged FK/CHECK and enforcement is engine-side at plan time.

## Expected behaviour

A column-level FK or CHECK added via `ALTER TABLE ADD COLUMN` must be persisted into the
store catalog DDL so that, after `rehydrateCatalog`, the constraint is reconstructed and
enforced (orphan inserts rejected; CHECK violations rejected) exactly as in the live
session — matching the existing `ADD CONSTRAINT`-survives-reopen behaviour
(`rehydrate-catalog.spec.ts` already guards the `ADD CONSTRAINT` FK case).

## Notes / design considerations

- The engine emit layer owns the column→FK/CHECK extraction; the store module receives
  only the raw `columnDef` (whose `constraints` DO carry the `REFERENCES`/`CHECK` AST).
  Two viable shapes: (a) have the store's addColumn extract column-level constraints from
  `change.columnDef.constraints` into its `updatedSchema` (parallel to its `addConstraint`
  arm, reusing `buildForeignKeyConstraintSchema` / the CHECK builder), or (b) give the
  engine a way to re-persist the merged schema into the module after validation. Option
  (a) keeps persistence local to the store and mirrors the existing `addConstraint` code;
  prefer it unless there is a reason to centralize.
- Whatever the chosen shape, the FK child-column index must be resolved against the
  **post-add** column set (the new column's index), matching how the emit layer resolves
  `resolvedForeignKeys`.
- Add a `rehydrate-catalog.spec.ts` test: ADD COLUMN with a column-level FK (and one with a
  CHECK) must reject orphan / violating inserts after `rehydrateCatalog`. A temporary probe
  during review confirmed the current behaviour accepts them.
- Verify this also covers the per-row (evaluator-default) path, not just literal defaults.
