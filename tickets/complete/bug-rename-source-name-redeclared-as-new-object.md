description: A schema declaration that renames a column, table, view, index or named constraint while also declaring a new object under the old name used to produce a broken migration; the diff now refuses it with a clear "Rename conflict" error.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # resolveRenames (guard, `noun`, `alsoDeclared` args); collectDeclaredConstraints (`onAddedColumns`); isUserConstraintName
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # §29
  - docs/schema-rename-detection.md   # conflicts list; pass-1 invariant sentence
----

# Refuse a rename whose old name is declared again as a new object

## What was wrong

`resolveRenames` paired declared objects with existing ones by name, then by `quereus.previous_name` / `quereus.id` hint, without checking whether the existing object a hint resolved to was also name-matched by another declared object. Declaring `x integer` plus `y integer with tags ("quereus.previous_name" = 'x')` against an existing `x` paired the declared `x` with the existing `x` (no ADD) while `y` renamed that same `x` away — the declared `x` silently went missing, or the plan failed mid-apply.

## What changed

- `resolveRenames` (non-`'deny'` path): when a hint resolves to an existing object whose name is also declared, throw `Rename conflict for <noun> '<name>': its rename source '<old>' is also declared as a new <noun>; apply the rename first, then remove the quereus.previous_name/id hint and declare '<old>' in a later apply`. Order-independent because `declared` is the full map.
- New optional `noun` argument (column renames now say "column", not "constraint").
- Review addition: new optional `alsoDeclared` argument — names that claim the namespace without being in `declared`. The named-constraint call passes `collectDeclaredConstraints(...).onAddedColumns`: user-named constraints written inline on an *added* column, which are deliberately left out of the named-constraint map (ADD COLUMN creates them). Small `isUserConstraintName` helper shared by both uses of the "user name, not `_`-prefixed" test.
- Docs: conflicts list in `docs/schema-rename-detection.md` (now also mentions the inline-on-added-column case); pass-1 invariant sentence says every old name is present and not declared.

## Tests

`50.2-declare-schema-renames.sqllogic` §29: column case (declared `x` before `y previous_name 'x'`), table case (`b29 previous_name 'a29'` plus a new `a29`), and — added in review — constraint case (`chk_new previous_name 'chk_old'` plus a new column `z` carrying inline `constraint chk_old`). Each case was confirmed to fail with its guard disabled.

## Validation

- `yarn workspace @quereus/quereus test`: 11185 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn test:store` not run: the guard throws inside the differ before any DDL runs, so the storage backend is not involved.

## Review findings

- **Read first:** the `ticket(implement): bug-rename-source-name-redeclared-as-new-object` diff, then every caller of `resolveRenames` (tables, views, indexes, columns via `resolveColumnRenames`, named constraints) to check that each `declared` map really holds every declared name of that kind.
- **Correctness, major (fixed inline):** the named-constraint `declared` map leaves out constraints written inline on added columns, so the guard missed `chk_new previous_name 'chk_old'` plus a new column `z ... constraint chk_old`. Probe result before the fix: the diff succeeded and `apply schema` failed mid-apply with `Cannot add constraint 'chk_old' ... already exists`, because a table's ADD COLUMN runs before its RENAME CONSTRAINT. Fixed with the `alsoDeclared` argument described above. Regression case added to §29 and verified failing without the fix.
- **Related case checked, no defect:** the same name reuse without a rename (drop `c1` from `x`, add column `z ... constraint c1`) applies cleanly, so no change was needed there.
- **Cross-kind name reuse** (table `y` renamed from table `x` while a *view* `x` is declared): outside this guard, which works per kind. It is not the bug this ticket fixed (no name-match pairing happens across kinds), and table renames run before view creates. Not probed; nothing filed.
- **`previous_name` lists:** with `y previous_name 'x, w'`, both existing and `x` declared, the guard refuses instead of falling through to `w`. I agree with the implementer: a hint that names an object that exists and is declared is ambiguous, and refusing it matches how the earlier conflict check treats the first existing candidate. No change.
- **Swaps and chains:** already refused by the earlier conflict check; the new guard does not change which cases are refused, only which message is raised first. Confirmed by the rest of 50.2 passing.
- **Error handling / type safety:** `QuereusError` with `StatusCode.ERROR`, same as the sibling conflicts. The `hintMatchKey!` non-null assertions pre-date this change and are safe because `hintMatch` implies `hintMatchKey`. No `any`.
- **Tests:** the implementer's §29 cases reproduce the bug at the user-facing layer. Kept, nothing cut.
- **Docs:** `docs/schema-rename-detection.md` updated (implementer, plus the inline-constraint note from review). `docs/schema-declarative.md` contains no list of rename conflicts, so it did not need changing.
- **Performance / resource cleanup:** nothing to note. One extra Set lookup per hinted object, and no resources are acquired.
- **Tripwires / tickets filed:** none.
