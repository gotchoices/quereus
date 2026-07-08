description: Break the one oversized materialized-views source file in the core engine into smaller single-purpose files, matching how its sibling files were already split up. No behavior change.
files:
  - packages/quereus/src/core/database-materialized-views.ts (3,655 lines — the file to decompose)
  - packages/quereus/src/core/database-assertions.ts (sibling: example of the target size/shape)
  - packages/quereus/src/core/database-transaction.ts (sibling)
  - packages/quereus/src/core/database-external-changes.ts (sibling)
difficulty: medium
----

## Problem

`core/database-materialized-views.ts` is 3,655 lines. Its sibling `database-*.ts`
files (`database-assertions.ts`, `database-transaction.ts`,
`database-external-changes.ts`, `database-watchers.ts`, `database-options.ts`, …)
were each decomposed into smaller, single-purpose modules; this one was not and
still carries the whole materialized-view surface in a single file.

This was one bullet of `5-core-smaller-cleanups`; it was split out because it is a
large, mechanical refactor that does not fit safely alongside the smaller edits in
that batch. It is **low-risk but bulky**: no logic change, just moving cohesive
groups of functions/methods into their own files and re-wiring imports/exports.

## Requirements

- **No behavior change.** This is a pure code-organization refactor. Build, lint,
  and the full `yarn test` suite must pass identically before and after.
- Split along the natural seams already present in the file (e.g. creation /
  registration, refresh / maintenance, dependency tracking, introspection, teardown
  — mirror whatever cohesive groupings the file already has as section boundaries).
- Match the **naming and size** of the existing decomposed siblings
  (`database-*.ts`). Do not invent a new module-layout convention — follow the one
  the siblings established.
- Keep the public surface stable: whatever `database.ts` (or other callers) import
  from `database-materialized-views.ts` today must still resolve, whether by
  re-export from a barrel/index or by updating the import sites.
- Preserve comment blocks and NOTE tripwires when moving code — do not drop them.

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus run lint`
- `yarn test` (materialized-view coverage lives across the logic suite plus
  `test/incremental/*`, `test/maintained-table-*.spec.ts`, `test/mv-rename-propagation.spec.ts`).

## Notes

- Because this touches only file boundaries and imports, a green diff is one where
  `git diff --stat` shows lines moving between files with no net logic delta. A
  reviewer should be able to confirm correctness largely by "these functions moved,
  unchanged."
- If it still does not fit one agent run, split further by module group (each new
  file is independent), chaining with `prereq:` — but keep each split a pure move.
