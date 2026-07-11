---
description: When a table is renamed, other saved tables that point at it keep pointing at the old name on disk until a moment later; a crash in that gap leaves those tables permanently pointing at a table that no longer exists.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable, propagateTableRename
  - packages/quereus-store/src/common/store-module.ts            # renameTable hook; persistCatalogIfChanged listener
  - packages/quereus-store/test/rename-catalog-durability.spec.ts # traceCatalogWrites harness to reuse
difficulty: medium
---

# `RENAME TABLE` leaves *other* tables' persisted definitions naming the old table

## What happens

Each persistent table stores its own `CREATE TABLE …` text under its own catalog key.
If table `child` has `foreign key (p) references parent (id)`, that text contains the
literal name `parent`.

Rename `parent` to `parent2`:

1. The store's `renameTable` hook writes `parent2`'s definition and deletes `parent`'s.
2. Control returns to the engine, which then walks every other table, rewrites
   `child`'s foreign key to name `parent2`, and fires a change event.
3. Only *then* does the store's catalog listener re-save `child`.

Between steps 1 and 3, `child`'s durable definition says `references parent (id)` while
no table named `parent` exists any more. A crash, a process kill, or a failed re-save
(the listener only logs a warning when its write fails) leaves that text on disk forever.

## Why it matters

On reopen the definition still parses, and foreign keys resolve their parent by name
lazily, so nothing complains at load time. The damage shows up later: every insert or
update on `child` that has to check the foreign key fails, because it is looking for a
table that was renamed. The user sees a healthy-looking database whose child table
cannot be written to, with no obvious cause.

## Scope

This is the multi-table sibling of the single-table bug fixed in
`bug-store-rename-column-persists-stale-index-predicate` (complete). That one was fixable
inside the module's own hook, because a table's self-references live in its own
definition. This one is not: the module's hook is handed one table and cannot know which
*other* tables name it.

Anything a rename rewrites in another table has the same exposure, not just foreign keys
— a `CHECK` expression or a view body that names the renamed table is re-persisted on the
same delayed event.

## Expected behavior

After `alter table parent rename to parent2`, no durable catalog entry — for any table —
should ever name `parent`. Equivalently: at no point during the rename should the set of
definitions on disk be one that would not rehydrate into a working database.

`docs/schema.md` currently documents catalog persistence as "best-effort durability" and
explicitly does not promise cross-table atomicity, so an accepted outcome for this ticket
may be a narrower guarantee (for example: rewrite dependents *before* the renamed table's
own entry is swapped, so the transient on-disk state names a table that still exists)
rather than full atomicity. Decide which, and say so in `docs/schema.md`.

## Reproduction sketch

`packages/quereus-store/test/rename-catalog-durability.spec.ts` already has a
`traceCatalogWrites()` helper that records every value durably written to the catalog
store. Point it at a two-table schema and assert that no recorded write for `child` names
`parent` — it will fail today.
