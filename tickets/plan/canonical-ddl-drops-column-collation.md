description: |
  Canonical table DDL (generateTableDDL / formatColumnDef) never emits a
  column-level `COLLATE <name>` clause. A column declared `... collate nocase`
  therefore loses its collation on any path that re-parses the canonical DDL —
  most importantly the store persistence round-trip (closeAll → reopen →
  rehydrateCatalog), which re-creates each table from its catalog DDL. After a
  reopen the column silently reverts to BINARY, changing comparison/sort/unique
  semantics. Index DDL already emits COLLATE correctly (generateIndexDDL); only
  the table column path is missing it.
files:
  - packages/quereus/src/schema/ddl-generator.ts    # formatColumnDef — add COLLATE emission (mirror generateIndexDDL line ~116)
  - packages/quereus/src/schema/column.ts            # ColumnSchema.collation (default 'BINARY')
  - packages/quereus-store/test/rehydrate-catalog.spec.ts  # add a collation-survives-reopen test
----

# Canonical column DDL silently drops COLLATE

## Problem

`formatColumnDef` in `ddl-generator.ts` emits the column name, logical type,
nullability annotation, inline `PRIMARY KEY`, `DEFAULT`, and tags — but **not**
`COLLATE`. Index column emission (`generateIndexDDL`, ~line 116) does emit
`COLLATE`, so the omission is specific to the table column path.

Because `@quereus/store` persists tables as their canonical DDL and rehydrates
by re-parsing it, a non-default column collation does not survive a close →
reopen:

```sql
create table t (name text collate nocase) using store;
-- ...close + reopen...
-- name is now BINARY: case-insensitive uniqueness / ordering silently lost
```

This is **pre-existing** (not introduced by
`lens-no-pk-nullable-column-deploy-mismatch`) and was surfaced while reviewing
that ticket's DDL round-trip reasoning. It also slightly weakens the
"byte-identical schema on re-parse" guarantee for any collated column, including
a collated synthesized all-columns key.

## Expected behavior

A column's declared collation must round-trip through canonical DDL so that a
store reopen reconstructs the same comparison semantics. `BINARY` (the default)
may be elided; any non-default collation must be emitted as
`COLLATE <quoteIdentifier(name)>`, matching the index-column convention.

## Validation

- Unit: `generateTableDDL` of `create table t (name text collate nocase)` emits
  `COLLATE NOCASE`; re-parsing preserves `collation === 'NOCASE'`.
- Store round-trip: a `collate nocase` column still enforces case-insensitive
  uniqueness / ordering after `rehydrateCatalog` (model after the existing
  constraint-survives-reopen tests in `rehydrate-catalog.spec.ts`).
