---
description: Rename detection in `diff schema` / `apply schema` driven by `with tags` hints (`quereus.id`, `quereus.previous_name`) instead of dropping + creating.
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic
  packages/quereus/test/schema-differ.spec.ts
  packages/quereus/test/schema-manager.spec.ts
  docs/sql.md
  docs/schema.md
  docs/todo.md
---

## What was built

`diff schema` / `apply schema` now detect renames driven by reserved metadata tags instead of always emitting drop + create:

- `"quereus.id"` — stable identifier; authoritative when both hints could match.
- `"quereus.previous_name"` — old name(s); accepts a comma-separated list with whitespace tolerance and case-insensitive name matching.

Scope: tables, views, indexes, named (table-level) constraints, and per-column entries. Tables and columns rename via the existing `ALTER TABLE ... RENAME` primitives (which already invoke the rename rewriter for dependents — CHECK expressions, FK targets, view bodies). Views, indexes, and named-constraint renames currently fall through to drop + recreate via the standard buckets when no engine primitive exists.

A new `OPTIONS (rename_policy = 'allow' | 'require-hint' | 'deny')` knob on `apply schema` controls strictness:

| Policy          | Behavior |
|-----------------|----------|
| `'allow'` (default) | Use hints when present; without hints, fall through to drop + create. |
| `'require-hint'`    | Reject any unhinted name change — drops *and* creates of the same kind both present after rename matching → error. |
| `'deny'`            | Ignore hints entirely — every name mismatch becomes drop + create (escape hatch / legacy mode). |

A *conflict* — declared name and a hint resolving to two distinct existing actuals — is always an error regardless of policy beyond `'deny'`.

## Key files

- `packages/quereus/src/schema/schema-differ.ts` — `RenamePolicy` type, `RenameOp`/`ColumnRenameOp` types, `SchemaDiff.renames`, `TableAlterDiff.columnsToRename` / `constraintsToRename`. Generic `resolveRenames<D, A>` helper handles tables, views, indexes, columns, and named constraints uniformly. `generateMigrationDDL` emits `ALTER TABLE old RENAME TO new` first, then drops, then creates, then per-table alters (RENAME COLUMN first within each alter block).
- `packages/quereus/src/schema/catalog.ts` — `CatalogTable` / `CatalogView` / `CatalogIndex` and per-column entries carry `tags`; `CatalogTable.namedConstraints` surfaces named CHECK / UNIQUE / FK constraints with their tags.
- `packages/quereus/src/runtime/emit/schema-declarative.ts` — `emitApplySchema` threads `applyStmt.options?.renamePolicy ?? 'allow'` into `computeSchemaDiff`. `emitDiffSchema` keeps `'allow'`.
- `packages/quereus/src/parser/parser.ts` — `apply schema ... options (rename_policy = '...')` parsed and validated at parse time. **Parser fix:** trailing `WITH TAGS` after an *unnamed* inline column constraint now attaches to the column rather than the constraint. Named constraints (`CONSTRAINT <name> ...`) still capture their own tags. Without this fix, the canonical `id integer primary key with tags ("quereus.previous_name" = ...)` shape would not have routed the rename hint to the column where the differ reads it.
- `packages/quereus/src/parser/ast.ts` — `ApplySchemaStmt.options.renamePolicy: 'allow' | 'require-hint' | 'deny'`.
- `packages/quereus/src/emit/ast-stringify.ts` — round-trip support for `rename_policy` option.
- `docs/sql.md`, `docs/schema.md`, `docs/todo.md` — documentation updated.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 2704 passing, 0 failing, 2 pending (pre-existing).

## Test coverage

`packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic` covers:

1. Table rename via `quereus.previous_name` — diff yields one `ALTER TABLE old RENAME TO new`; apply preserves rows; round-trip diff is empty.
2. Table rename via `quereus.id` — id wins over a non-matching `previous_name`.
3. Column rename inside an otherwise-unchanged table — diff yields `ALTER TABLE t RENAME COLUMN`; data preserved.
4. Multi-step `previous_name = 'a, b'` resolves to whichever of `a` or `b` actually exists.
5. Conflict: declared name and `previous_name` both resolve to existing distinct actuals → `Rename conflict for table 'foo'` error.
6. `rename_policy = 'require-hint'` rejects an unhinted name change.
7. `rename_policy = 'deny'` produces drop + create even when hints are present (data loss demonstrated).
8. Combined: table rename + column rename + new column add in one apply, with FK from a child table to the renamed parent preserved (FK enforcement still fires post-rename).

`packages/quereus/test/schema-manager.spec.ts` exercises the parser fix:
- Unnamed-constraint trailing `WITH TAGS` attaches to the column.
- Named CHECK constraint `WITH TAGS` attaches to the constraint.
- Schema-hash stability regardless of tags is verified by `test/schema/catalog.spec.ts` (`stripTagsFromDeclaredSchema`).

`packages/quereus/test/schema-differ.spec.ts` continues to cover identifier quoting in `generateMigrationDDL` plus malformed `defaultVtabArgs` JSON; new `renames: []` field threaded through every existing fixture.

## Usage

```sql
declare schema main {
  table customer with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  ) {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name   text not null      with tags ("quereus.previous_name" = 'name')
  }
}

-- Diff against existing client(client_id, name):
diff schema main;
-- → ALTER TABLE client RENAME TO customer
--    ALTER TABLE customer RENAME COLUMN client_id TO customer_id
--    ALTER TABLE customer RENAME COLUMN name TO full_name

apply schema main;                                          -- default rename_policy = 'allow'
apply schema main options (rename_policy = 'require-hint'); -- error if any unhinted drop+create remains
apply schema main options (rename_policy = 'deny');         -- ignore hints; drop+create
```

## Deferrals (out of scope)

- Engine-level RENAME primitives for views, indexes, and named constraints — currently drop + recreate when hinted.
- Heuristic rename matching without hints (column type / positional similarity) — explicitly out of scope; always require a hint.
- `diff schema` does not yet accept an `OPTIONS` clause; its policy is fixed at `'allow'` for v1. `apply schema` is where the knob lives.
