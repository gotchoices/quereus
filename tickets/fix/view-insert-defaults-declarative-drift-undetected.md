description: A clause-only `insert defaults` change on a name-matched declarative view or materialized view diffs empty — `apply schema` silently keeps the old defaults. The deprecated `default_for` view-DDL tag WAS drift-detected (tagsDrifted → in-place SET TAGS), so migrating tag → clause loses declarative drift detection entirely; plain-view BODY drift is also undetected (pre-existing, broader hole the clause now shares).
files:
  - packages/quereus/src/schema/schema-differ.ts        # views block (~408): name-matched views check only tagsDrifted; MV block (~431): bodyHash covers stmt.select only, clause outside it
  - packages/quereus/src/schema/catalog.ts              # CatalogView { name, ddl, tags } / CatalogMaterializedView { name, ddl, bodyHash, tags } — no insertDefaults field today (ddl string does carry the clause)
  - packages/quereus/src/emit/ast-stringify.ts          # insertDefaultsClauseToString — canonical rendering both diff sides can compare
  - packages/quereus/test/logic/50-declarative-schema.sqllogic  # round-trip cases exist (~1063); drift cases do not
----

# Declarative differ misses `insert defaults` drift (and plain-view body drift)

## Reproduction (verified on the live engine, 2026-06-09)

```sql
declare schema main {
  table t1 ( id INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL )
  view v1 as select id, name from t1 insert defaults (created = 111)
}
apply schema main;
insert into v1 values (1, 'a');          -- created = 111 ✓

declare schema main {
  table t1 ( id INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL )
  view v1 as select id, name from t1 insert defaults (created = 222)
}
diff schema main;                         -- → []  (expected: a recreate)
apply schema main;
insert into v1 values (2, 'b');          -- created = 111  ← stale default, silent
```

The same holds for a materialized view: `bodyHash` is computed over `stmt.select` only
(`computeBodyHash(astToString(declaredMv.viewStmt.select))`), so a clause-only change
matches the live `bodyHash`, `tagsDrifted` no longer sees it (the clause is not a tag),
and the MV branch emits nothing.

## Why this is a (soft) regression, not just a gap

The construct this clause replaces — the `quereus.update.default_for.<col>` **view-DDL
tag** — was part of `tags`, so a tag-only change was caught by `tagsDrifted` and applied
in place via `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS`. A user who
migrates tag → clause (the documented direction; the tag site is deprecated and dies in
`remove-view-default-for-tag`) loses declarative drift detection for their defaults.
Once `remove-view-default-for-tag` lands there is no diffable spelling at all.

## The pre-existing, broader hole

A name-matched plain view's **body** change is also undetected (verified: changing the
view's `where` clause diffs empty too). The views block pairs by name and checks only
`tagsDrifted`; there is no view analogue of the MV `bodyHash` compare or the index
canonical-body compare. Any fix for the clause should decide whether to close the body
hole in the same stroke — detecting clause drift while ignoring body drift would be an
odd asymmetry.

## Expected behavior

- A name-matched plain view whose definition (body or `insert defaults` clause) differs
  from the declared item drops + recreates (views are data-free; recreate is cheap).
  There is no in-place primitive for either, so drop+recreate is the only shape — mirror
  the index body-recreate pattern, including the `require-hint` policy exclusion
  (`enforceRequireHint` must not count a body-recreate as an unhinted rename; see
  `indexBodyRecreates`).
- A name-matched MV whose clause differs drops + recreates (re-materializes), exactly as
  a body change does today. Either fold the clause into the hashed canonical body, or
  compare the clause separately (e.g. `insertDefaultsClauseToString` on both sides —
  `CatalogMaterializedView` would need to carry the live clause or its rendering;
  the `ddl` string already embeds it).
- Tag-only drift keeps its in-place `SET TAGS` path (no recreate churn).
- 50-declarative-schema.sqllogic gains drift cases: clause changed / clause added /
  clause removed / body changed, for both view and MV — each asserting the diff renders
  the recreate and a post-apply write-through uses the NEW default.

## Notes

- `CatalogView.ddl` / `CatalogMaterializedView.ddl` are produced by
  `generateViewDDL` / `generateMaterializedViewDDL` and already embed the clause, so a
  canonical-DDL (or re-parsed-AST) comparison needs no schema-shape change; comparing
  re-parsed ASTs structurally (loc-insensitive) would avoid whitespace/case churn —
  `test/emit-roundtrip-comparator.ts` shows the shape of loc-insensitive AST compare.
- Watch identifier-case and default-collation churn: the index canonical-body work
  (`2.1-index-canonical-body-collation`, `canonical-body-column-name-case-normalization`)
  documents the pitfalls of comparing rendered DDL across diff sides.
