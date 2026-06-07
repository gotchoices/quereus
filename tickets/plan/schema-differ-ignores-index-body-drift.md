description: The declarative schema differ matches indexes by name only and compares solely their tags — a change to a declared index's UNIQUE-ness or partial WHERE predicate (same name) produces no migration. Surfaced while reviewing index-ddl-roundtrip.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts          # index diff loop (~L431-445); compare with the view/MV bodyHash path (~L410-426)
  - packages/quereus/src/schema/ddl-generator.ts          # generateIndexDDL now emits UNIQUE + WHERE (the lossless actual-side DDL)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # "declarative differ stability" describe — extend with a drift case
----

# Schema differ ignores index body drift (unique / partial predicate)

## Problem

`computeSchemaDiff` (schema-differ.ts) resolves indexes by **name only**. When a
declared index matches an actual index by name, the only further check is
`tagsDrifted(...)` → an in-place `SET TAGS`. Unlike views and materialized views
— which compute a `bodyHash` and drop+recreate on body change — the index loop
never compares the index *body*: not the column list, not `UNIQUE`, not the
partial `WHERE` predicate.

Consequence: if a user edits a `declare schema { ... }` index in place (same
name) to add/remove `UNIQUE` or change/add/remove its `WHERE` predicate, the
differ emits **no migration**. The applied catalog silently retains the old
shape. This is a correctness gap in the declarative-schema apply path.

This was a pre-existing limitation, but it became more visible with
`index-ddl-roundtrip`: `generateIndexDDL` now emits a *lossless* actual-side DDL
(`CREATE [UNIQUE] INDEX ... [WHERE ...]`), so the actual catalog now carries the
information the differ would need to detect drift — it just doesn't look at it.
(See that ticket's "Known gaps" #2.)

## Expected behavior

A declared index whose body (columns / direction / collation / `UNIQUE` /
partial predicate) differs from the actual index of the same name should produce
a drop+recreate migration (mirroring the view/MV `bodyHash` path), subject to the
same rename-hint policy already applied to creates/drops.

## Notes / open questions

- The natural implementation mirrors the MV path: compute a canonical body
  rendering for the declared index (the AST emitter `createIndexToString` already
  exists) and for the actual index (its persisted `ddl` / a canonicalized form),
  compare, and drop+recreate on mismatch — while still doing the in-place
  `SET TAGS` when only tags drifted.
- Watch for false churn: the declared-side render (from the `declare schema`
  AST) and the actual-side render (from `generateIndexDDL`) must be normalized to
  the *same* canonical form, exactly as the constraint-body comparison already
  does via a shared renderer. Note the declarative `declare schema { ... }`
  index grammar currently parses **no** `WHERE` clause (`declareIndexItem`), so
  partial indexes can't even be declared today — closing that grammar gap is a
  prerequisite for testing partial-predicate drift end-to-end.
- Add a regression test under the "declarative differ stability" describe in
  `index-ddl-roundtrip.spec.ts`: declare a plain index, apply, then re-declare it
  `UNIQUE` and assert the diff now contains a drop+recreate (today it is empty).
