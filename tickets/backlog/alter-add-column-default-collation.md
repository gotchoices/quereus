description: Decide whether ALTER TABLE ADD COLUMN / RENAME COLUMN should honor the session `default_collation` option (it currently does not — only CREATE TABLE does).
prereq: default-collation-pragma
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/common/store-module.ts (quereus-store), packages/quereus/src/schema/table.ts
----

## Context

`default-collation-pragma` introduced a per-DB `default_collation` session option that sets the
declared collation for columns with no explicit `COLLATE`. To keep that ticket single-run-sized
and matching its stated scope ("only for user-authored CREATE"), the ALTER paths were
deliberately left resolving an omitted `COLLATE` to the fixed `'BINARY'` default param:

- `vtab/memory/layer/manager.ts` `addColumn` / `renameColumn`
- `quereus-store` `store-module.ts` `addColumn` / `renameColumn`

Both call `columnDefToSchema(def, defaultNotNull)` without the new `defaultCollation` arg, so they
default to `BINARY`.

## The question

`ALTER TABLE t ADD COLUMN c text` is also user-authored DDL. Under `default_collation = nocase`,
a CREATE-d text column becomes `NOCASE` but an ADD-COLUMN-ed one stays `BINARY` — an inconsistency
that is a potential footgun.

Decide:
- Should ADD COLUMN / RENAME COLUMN resolve an omitted `COLLATE` via the session
  `default_collation` (using the shared `resolveDefaultCollation` helper), matching CREATE?
- If yes: thread the session option into all four call sites, and verify the resulting column
  round-trips (the store persists the column's DDL; a non-BINARY collation must emit explicit
  `COLLATE` so reopen is stable — same canonical-persistence rule as CREATE).
- Edge cases to cover: ADD COLUMN of a non-text type under a non-BINARY default (must fall back
  to BINARY via the helper); the isolation layer's `deriveAddColumnBackfill`
  (`quereus-isolation/isolation-module.ts`) which independently recomputes the new column via
  `columnDefToSchema` and would need the same arg to stay consistent with the underlying.

Likely small once `resolveDefaultCollation` exists, but it spans memory + store + isolation
packages, so size accordingly.
