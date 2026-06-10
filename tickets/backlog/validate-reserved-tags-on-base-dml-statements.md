----
description: Statement-level `WITH TAGS` on base-table DML never reaches reserved-tag validation — a `quereus.*` key there is silently inert, breaking the fail-loudly posture.
files:
  - packages/quereus/src/planner/mutation/mutation-tags.ts   # the only 'dml-stmt' validation site today (view path)
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/delete.ts
  - packages/quereus/src/schema/reserved-tags.ts
----

# Validate reserved tags on base-table DML statements

`insert/update/delete … with tags (…)` is parsed onto `stmt.tags` for every DML
statement, but reserved-tag validation at the `dml-stmt` site fires only inside
`validateMutationTags`, which runs exclusively on the view-/MV-mediated write path
(`buildViewMutation`). A base-table DML carrying a reserved key —
`insert into t with tags ("quereus.bogus" = 1) values (…)` or a retired key like
`"quereus.update.default_for.x"` — is silently accepted and inert, while the
identical statement through a view fails loudly with `unknown-reserved-tag`.

This asymmetry predates the `quereus.update.*` removal (the statement-level tag
reader also only ran on the view path), but now that **no** reserved key is legal
at `dml-stmt`, validation there is a pure typo guard with no behavioral risk.

## Expected behavior

- A `quereus.*` key in a DML statement's `WITH TAGS` clause is validated at the
  `dml-stmt` site regardless of whether the target is a base table, view, or MV —
  same registry, same hard-error-on-unknown severity as every other authoring
  surface (docs/sql.md "An unrecognized or mis-sited `quereus.*` key is a hard
  error … on every authoring path").
- Free-form (non-`quereus.*`) statement tags remain accepted untouched.
- The view path's existing validation must not double-raise (one sited error).

## Notes

- Consider a single shared validation point early in DML plan-build rather than
  per-builder calls, mirroring how `raiseStmtTagDiagnostics` unified the DDL
  surfaces.
- docs/sql.md's "every authoring path" claim should then be literally true for
  the statement-level site too; update the docs if any deliberate carve-out
  remains.
