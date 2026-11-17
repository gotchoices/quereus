description: A schema declaration that renames a column (or table, view, index, constraint) and also declares a new object under the old name gets a broken migration; make the diff refuse that declaration with a clear "Rename conflict" error instead.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # resolveRenames ~1101 (the per-declared loop ~1155-1206); resolveColumnRenames ~2311 passes kind 'constraint' for columns
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # §5 is the existing conflict test; add the new section after the last (§28)
  - docs/schema-rename-detection.md   # "Conflicts …" paragraph near the top; the pass-1 sentence (~line 27) about chains/swaps
repro: verified
----

# Refuse a rename whose old name is declared again as a new object

## The bug

`resolveRenames` (in `schema-differ.ts`) pairs each declared object with an existing object, first by name and then by the `quereus.previous_name` / `quereus.id` rename hints. It never checks whether the existing object a declared name matches is also claimed, through a hint, as the rename source of another declared object. So with an existing column `x` and this declaration:

```sql
declare schema main { table t { id integer primary key, y integer with tags ("quereus.previous_name" = 'x'), x integer } }
```

the declared `x` pairs with the existing `x` (treated as already present, so no ADD COLUMN), and the declared `y` renames the same existing `x` away. Declaration order does not matter. Reproduced on the memory backend in this session:

- Column, `x integer` redeclared unchanged: the plan is only `ALTER TABLE t RENAME COLUMN x TO y`; apply succeeds and the declared `x` is silently missing.
- Column, `x integer null` (differs from the old `x`): the plan adds `ALTER TABLE t ALTER COLUMN x DROP NOT NULL`, and apply fails with `Failed to execute DDL … Column 'x' not found`.
- Table, `table b … with tags ("quereus.previous_name" = 'a')` plus `table a { id …, extra integer null }`: plan is `ALTER TABLE a RENAME TO b` then `ALTER TABLE a ADD COLUMN extra integer null`, which fails.
- View and index (`view vb … previous_name 'va'` + a new `view va` with a different body; same for indexes): the plan happens to work, because view/index renames are drop+recreate and the body differs, but it emits `DROP VIEW IF EXISTS va` twice. With an unchanged body for the new `va` it would drop `va` and never recreate it.

## Decision: refuse, do not honour

The ticket allowed either honouring the declaration (rename, then create the new object under the freed name) or refusing it. Refuse, for this reason, observed in the same reproduction: **a declaration that keeps the rename hint and also declares the old name can never re-diff cleanly.** After any apply that leaves both `y` and a new `x` in the catalog, every later `diff schema` on that same declaration throws the existing conflict (`Rename conflict … declared name and quereus.previous_name/id resolve to different existing objects ('y' vs 'x')`), because `y`'s name matches `y` while its hint still resolves to the new `x`. Measured: rename-only apply, then a second apply adding `x`, then a third `diff schema` → that error. Honouring the shape in one apply would only make the user reach that permanently failing state sooner. The supported path is two applies: apply the rename, then remove the hint and declare the new object.

Refusing also keeps the invariant the reconcile code relies on (`docs/schema-rename-detection.md`, pass 1): every rename's new name is absent from the actual catalog and every old name is present and *not otherwise declared*, so no name changes meaning partway through a plan.

## Design

In `resolveRenames`, outside `'deny'` (which ignores hints and is unaffected): when a declared object `d` resolves a hint to an existing object `hintMatchKey` that is not itself (`!hintIsSelf`), and `declared.has(hintMatchKey)` — i.e. the rename source's name is also declared as an object of the same kind — throw a `QuereusError` (`StatusCode.ERROR`) whose message begins `Rename conflict for <noun> '<declared name of d>'`, names the old name, and tells the user to apply the rename first and then remove the hint before declaring the old name again. Suggested wording:

`Rename conflict for column 'y': its rename source 'x' is also declared as a new column; apply the rename first, then remove the quereus.previous_name/id hint and declare 'x' in a later apply`

Notes for the implementer:

- Place the check so it fires regardless of declaration order. Checking `declared.has(hintMatchKey)` at the point the hint resolves does that, since `declared` is the full map.
- If `d` also has a name match, the existing "declared name and hint resolve to different existing objects" conflict already throws; either error is acceptable there, so do not reorder that check.
- Chains (`b` hints `a`, `c` hints `b`, with `a` and `b` existing) already throw through the existing conflict on `b`; the new check also catches `c`. Both are `Rename conflict` errors, so §5 and the other existing tests should be unaffected — confirm.
- Column error noun: `resolveColumnRenames` passes `kind: 'constraint'` (comment says the kind is unused for columns), so every column conflict message, existing and new, says "constraint 'y'" — observed in this session. Make column errors say "column". Smallest fix: an optional message noun on `resolveRenames` (defaulting to `kind`) rather than adding `'column'` to the exported `RenameKind` union, which `RenameOp` consumers switch on.
- `computeSchemaDiff` runs table/view/index `resolveRenames` before emitting anything, and column/constraint resolution inside `computeTableAlterDiff`, so the refusal surfaces from `diff schema` / `apply schema` before any DDL runs. Verify with `diff schema`.

## Test

One new section in `50.2-declare-schema-renames.sqllogic` (the reproduction, at the layer users hit), after §28, following §5's style:

- Column: `create table t (id integer primary key, x integer)`, declare `y` with `previous_name = 'x'` **after** a redeclared `x` (so the check is shown not to depend on order), `diff schema main;` → `-- error: Rename conflict for column 'y'`.
- Table: `create table a (id integer primary key)`, declare `table b … previous_name 'a'` plus `table a { id …, extra integer null }`, `diff schema main;` → `-- error: Rename conflict for table 'b'`.
- Clean up the tables afterwards as §5 does.

Views, indexes and constraints share the same code path; no separate tests for them.

## Docs

`docs/schema-rename-detection.md`:

- The "Conflicts (declared name and hint resolving to two distinct existing objects) always throw" paragraph: add the second conflict — a hint whose rename source is also declared under its old name — with the two-apply path, and one sentence that a hint left in place after its old name has been reused for a new object makes later diffs throw the first conflict, so hints should be removed once the old name is reused.
- The pass-1 sentence ("`resolveRenames` makes rename chains/swaps unrepresentable — every new name is absent from the actual catalog while every old name is present"): extend to say every old name is also not declared, so no name is both a rename source and a declared object.

## TODO

- Add the rename-source-redeclared check in `resolveRenames` (non-`deny` path), throwing `Rename conflict for <noun> '<name>' …`.
- Give column conflicts the noun "column" (optional message noun on `resolveRenames`; `resolveColumnRenames` passes it).
- Add the §29 sqllogic section (column + table cases) to `50.2-declare-schema-renames.sqllogic`.
- Update `docs/schema-rename-detection.md` (conflicts paragraph + pass-1 invariant sentence).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; check no existing test asserted the old "constraint" noun for a column conflict (`grep -rn "Rename conflict for constraint" packages/quereus/test`).
