description: A *reshaping* re-attach on a maintained table (`alter table … set maintained (cols) as …`, or the implicit reshape-on-attach) rebuilds the live catalog record from the backing module's post-ALTER `TableSchema`, which is derivation-less AND carries no catalog table tags — so a SET TAGS riding the same diff is silently dropped. A non-reshaping (body-only) re-attach preserves tags. Pre-existing on the implicit path; the explicit rename-list reshape (ticket maintained-reattach-explicit-rename-list-reshape) inherits the same gap.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # reshaping re-attach: `live = { ...current, derivation }` (~1102, ~1138) and reshapeBackingInPlace (~2261) drop catalog tags from `current`
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts   # "a concurrent tag change + rename-list change…" (~222) — the KNOWN GAP note (~241) and the deliberately-unasserted tag value
difficulty: medium
----

# Reshaping re-attach drops a concurrent SET TAGS on a maintained table

## Symptom

When a single `apply schema` carries BOTH a derivation reshape (a rename-list
change `(a, b)` → `(a, c)`, an implicit output-column rename, or any backing
column op) AND a table-tag drift on the same maintained table, the reshape
applies but the tag change is **lost**. A re-diff afterward still wants the tag
change, so it never converges on the tag (though the reshape itself converges).

## Root cause

In `materialized-view-helpers.ts` the reshaping re-attach path rebuilds the live
catalog record from the module's post-ALTER schema:

```ts
current = await module.alterTable!(db, schemaName, name, reshapeOpToChange(op));
live = { ...current, derivation: maintained.derivation };   // <-- current is derivation-less AND tag-less
schema.addTable(live);
```

`module.alterTable` returns a fresh `TableSchema` reflecting the module's column
shape only — it does not carry the catalog's `tags`. The code spreads `current`
and re-grafts `derivation`, but **not** the tags that the differ's
`tableTagsChange` / `markMaintainedTagRoute` routing intended to apply via the
`ALTER MATERIALIZED VIEW … SET TAGS` leg. The same drop occurs in
`reshapeBackingInPlace` (~2261), so the REFRESH-driven reshape arm has it too.

A NON-reshaping re-attach (body-only, no column ops) keeps the existing `live`
record and its tags, so the gap is scoped strictly to the reshape arms.

## Expected

A reshaping re-attach that also changes table tags must land BOTH: the reshaped
backing AND the declared tags, converging in one apply. Carry the declared
tags onto the rebuilt `live` record (graft from the prior maintained record /
the differ's `tableTagsChange`, alongside the `derivation` graft), mirroring how
the non-reshaping path preserves them.

## Repro

`maintained-table-differ-coverage.spec.ts` § "a concurrent tag change +
rename-list change coexist on one diff and the rename lands" sets up the exact
case: `mv (a, b)` with `team.owner = 'old'` → `mv (a, c)` with
`team.owner = 'new'`. The test deliberately does NOT assert the post-apply tag
value (only that the rename lands and converges) precisely because of this gap.
Once fixed, tighten that test to assert `mv.tags['team.owner'] === 'new'` and
remove the KNOWN GAP note (~241–250).

## Notes

- Orthogonal to the rename-list reshape feature itself — that converges
  regardless. This is a tag-routing omission in the shared reshape machinery.
- Confirm both reshape arms (the `set maintained` attach/re-attach in
  `materialized-view-helpers.ts` ~1089–1160 and `reshapeBackingInPlace` ~2241+)
  carry tags, since REFRESH and declarative apply share the post-reshape
  re-register.
- Check the failure-restore branches (`restoreReshaped` / `markMaterializedViewStale`)
  do not re-introduce the stale (tag-less) record.
