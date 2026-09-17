---
description: Re-applying a schema that spells a column type with a common alias (like `int` for `integer`, or `varchar(20)` for `text`) no longer asks to retype that column — the declared type is compared against the catalog's canonical type name, not against its raw spelling.
files:
  - packages/quereus/src/schema/schema-differ.ts       # computeColumnAttributeChange, ~2713 — the data-type comparison
  - packages/quereus/src/schema/catalog.ts             # tableSchemaToCatalog, ~283 — catalog column `type` is `logicalType.name` (canonical, e.g. `INTEGER`)
  - packages/quereus/src/types/registry.ts             # inferType — resolves a declared spelling to its logical type
  - packages/quereus/test/schema/differ-alter-column.spec.ts  # new spec: "does not treat a type alias as a retype"
---

# What was wrong

`diff schema` is meant to be empty right after `apply schema` of the same declaration.
`computeColumnAttributeChange` compared the declared column's raw type spelling against
the catalog's canonical type name case-insensitively:

```ts
if (declared.dataType && declared.dataType.toLowerCase() !== actual.type.toLowerCase()) {
```

The catalog's `type` field is always the resolved logical type name (`INTEGER`, `TEXT`,
`REAL`, …), set in `tableSchemaToCatalog`. The declared side is whatever the author typed
(`int`, `varchar(20)`). Any spelling other than the exact canonical name compared unequal,
so a column declared `int` or `varchar(n)` reported a spurious
`ALTER COLUMN … SET DATA TYPE` on every re-apply of an unchanged schema.

Reported from a downstream project (optimystic) where this broke a warm restart: memory
tables silently accepted the no-op retype (rewriting every row's column value for nothing),
and any vtab module without `alterTable` support — including optimystic's own — threw
`Module for table '…' does not support ALTER COLUMN` on the second `apply schema` in a
process, or on every restart.

# What changed

The comparison now resolves the declared spelling to its logical type first, via the same
`inferType` already used a few lines away for collation defaults:

```ts
if (declared.dataType && inferType(declared.dataType).name.toUpperCase() !== actual.type.toUpperCase()) {
```

`inferType` applies the engine's normal type-affinity rules (`INT` → `INTEGER`, `VARCHAR(n)`
/ `CHAR` / `CLOB` → `TEXT`, etc.), so an alias and its canonical name now compare equal. A
genuine type change (`real` vs `integer`) still resolves to different logical types and
still emits the retype.

Note: the catalog never tracked length/precision/scale (`type` is only the logical type
name) — before this fix, a `varchar(n)` column already couldn't round-trip cleanly for a
different reason (every spelling but the literal string `TEXT` mismatched), so this fix
doesn't remove any existing length-diffing behavior; there wasn't any to begin with. Diffing
length/precision is a separate, currently-absent feature, out of scope here.

# Validation

- New spec: `differ-alter-column.spec.ts` § "does not treat a type alias as a retype (int
  vs INTEGER, varchar(20) vs TEXT)" — declares `u int, v varchar(20)` against a catalog
  recording `INTEGER` / `TEXT`, asserts `diff.tablesToAlter` is empty. Fails against the
  pre-fix code, passes after.
- Reproduced the exact reported repro end-to-end (memory tables, `declare schema` /
  `apply schema` / `diff schema`) — printed the two spurious `SET DATA TYPE` rows before
  the fix, prints nothing after.
- `yarn test` (whole `@quereus/quereus` workspace): 10399 passing, 25 pending, 0 failing.
- `yarn lint` (eslint + test-file typecheck): clean.

No separate fix/implement/review tickets were opened — the defect was reported with the
exact root-cause line already diagnosed, so it was verified and fixed directly in one pass.
