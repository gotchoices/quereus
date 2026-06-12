description: On the store backend, ALTER TABLE ADD CONSTRAINT of a collation-conflicting FK persists the FK to disk before the engine's declaration-time collation validator rejects it. The engine catalog stays clean (the validator throws before `schema.addTable`), but the store module's `alterTable` already called `saveTableDDL` / `table.updateSchema`, so the rejected FK survives on disk and rehydrates (unvalidated, by the reload-tolerance rule) on the next store reopen — surfacing only at DML. A "rejected" ALTER thus half-succeeds on the persisted catalog.
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts          # runAddConstraintViaModule: validator runs AFTER module.alterTable returns
  - packages/quereus/src/schema/constraint-builder.ts            # validateForeignKeyCollations + buildForeignKeyConstraintSchema (both exported)
  - packages/quereus-store/...                                   # store module alterTable persists DDL before returning (confirm exact path)
  - packages/quereus/test/logic/41.1-fk-collation-conflict.sqllogic  # § 8 covers in-session rejection; no store-reopen coverage
difficulty: medium
----

## Problem

`runAddConstraintViaModule` (emit layer) validates a newly-added FK's child/parent
collation pairing **after** `module.alterTable` returns:

```
const updatedTableSchema = await module.alterTable(...);   // store: already saveTableDDL'd + updateSchema'd
// ... validator runs here, throws on conflict ...
schema.addTable(updatedTableSchema);                       // never reached on conflict
```

On the **memory** module this is benign — nothing is persisted, and the engine
catalog (authoritative for planning) never receives the FK. On the **store**
module the divergence is observable:

- In-session: the engine SchemaManager has no FK (throw precedes `addTable`), so
  the rejected FK is never used. A subsequent `DROP TABLE` cleans the store entry.
- **On store reopen**: the persisted conflicting FK rehydrates without error
  (rehydrate intentionally does not re-validate — the "reload must not reject"
  rule), and the conflict surfaces only at the first DML against the child.

So the implement ticket's "a rejected ALTER leaves the table untouched" guarantee
holds for the engine catalog but NOT for the store's persisted catalog. A user who
runs a conflicting `ADD CONSTRAINT`, sees it rejected, then reopens the database
finds the constraint present. This is the one ADD-CONSTRAINT-specific wart;
CREATE TABLE and ADD COLUMN have no equivalent (CREATE validates before `addTable`
with nothing persisted yet; ADD COLUMN validates first inside its try/revert
region).

## Expected behavior

A conflicting-collation `ALTER … ADD CONSTRAINT FOREIGN KEY` should be rejected
*before* any persistence side effect, so the persisted catalog matches the
in-session engine catalog: the table is untouched on disk, and a reopen shows no
trace of the rejected FK.

## Suggested approach (for the implementer to evaluate)

Pre-build the FK schema from the AST constraint against the prior `tableSchema`'s
column index map and validate **before** calling `module.alterTable`. The FK's
child columns already exist on the table at ADD CONSTRAINT time, so resolution
against the prior schema is well-defined. Both helpers are already exported:

- `buildForeignKeyConstraintSchema(con, columnIndexMap, childTableName, childSchemaName)`
- `validateForeignKeyCollations(db, childSchema, fk)`

This also removes the current dependency on `foreign_keys = OFF` to make the
declaration-time check the rejecting mechanism (see implement gap #2): with
pre-validation, the conflict is caught before the module's existing-row scan runs.

Confirm the AST constraint shape on `AddConstraintNode['constraint']` matches what
`buildForeignKeyConstraintSchema` expects (an `AST.TableConstraint` with
`type === 'foreignKey'`); only FK constraints need the new pre-check (UNIQUE/CHECK
ADD CONSTRAINT have no collation pairing).

## Testing

Add a store-mode case to `41.1-fk-collation-conflict.sqllogic` (or a dedicated
store-reopen test if the harness supports reopen) asserting that after a rejected
ADD CONSTRAINT, a store reopen shows the table with NO conflicting FK. The
existing § 8 (in-session rejection) must keep passing on both backends.
