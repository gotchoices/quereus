---
description: One-line corpus fix to `41-alter-table.sqllogic:131` so the NOT NULL alter-table assertion is portable across `default_column_nullability` settings. Path B (the `executeExpectingError` no-error-throw) is already in place from `sqllogic-error-directive-ordering`, so only Path A is needed.
prereq:
files:
  - packages/quereus/test/logic/41-alter-table.sqllogic
---

# Make 41-alter-table.sqllogic NOT-NULL assertion explicit

## Background — what was actually happening

The original ticket (`tickets/fix/41-alter-table-not-null-corpus-drift.md`) hypothesised that `alter table t_notnull add column required text;` was creating a nullable column and the alter was succeeding silently — passing only because of a pre-existing tautology in `executeExpectingError`.

Two corrections to that hypothesis surfaced during the fix-stage analysis:

1. **Path B is already done.** `packages/quereus/src/parser/parser.ts` does parse `required` as a column name and `text` as the type with no constraints (confirmed by tracing `columnDefinition()` and `isColumnConstraintStart()`). But `logic.spec.ts:578-600` (`executeExpectingError`) already structures the no-error throw outside the surrounding try/catch — that fix landed with `sqllogic-error-directive-ordering`. So the tautology described in the original ticket no longer exists.

2. **The implicit-NOT-NULL behaviour comes from a database option, not the parser.** `packages/quereus/src/core/database.ts:222-234` registers `default_column_nullability` with default `'not_null'` (Third Manifesto). `packages/quereus/src/vtab/memory/layer/manager.ts:894-919` reads that option in `addColumn`, and `columnDefToSchema` applies it when no explicit `NULL`/`NOT NULL` constraint is on the column. So under upstream Quereus defaults, `add column required text;` *does* create a NOT NULL column and the alter on a non-empty table genuinely fails — the corpus passes for a real reason, not via tautology.

The drift the original ticket reports is real *only* for downstream consumers that override `default_column_nullability` to `'nullable'` (SQL standard) — e.g. lamina's runner, which is why lamina maintains an `ALTER_TABLE_NOT_NULL_CORPUS_DRIFT` known-failure entry.

## Fix — make the constraint explicit

`packages/quereus/test/logic/41-alter-table.sqllogic:131`:

```diff
 -- NOT NULL without DEFAULT should fail (table has rows)
-alter table t_notnull add column required text;
+alter table t_notnull add column required text not null;
 -- error: NOT NULL
```

This makes the SQL match the comment, removes the dependency on `default_column_nullability`, and produces the same NOT NULL error under both `'not_null'` and `'nullable'` defaults. The line 142 case (`add column required text not null default 'default_val'`) is already explicit, so the corpus is internally consistent after the change.

## Status

The corpus edit is **already in the working tree** (applied during the fix-stage analysis). Verified:

- `node test-runner.mjs --grep "41-alter-table"` → 1 passing, no regressions.

A grep across the logic corpus for the original authoring pattern (`add column \w+ text;` immediately followed by `-- error:`) surfaces no other instances; the one match at line 30 of the same file is unrelated (duplicate-column detection).

## Acceptance

- `41-alter-table.sqllogic` passes upstream and (per the original ticket's downstream-impact note) lamina can drop its `ALTER_TABLE_NOT_NULL_CORPUS_DRIFT` known-failure entry once it consumes the new quereus version.

## TODO

- Verify the corpus change is in place at `packages/quereus/test/logic/41-alter-table.sqllogic:131` (already applied).
- Run `node test-runner.mjs --grep "41-alter-table"` and confirm 1 passing.
- Run the full quereus test suite (`yarn workspace @quereus/quereus test`) to confirm no regressions.
- Move to `review/` with a one-line summary referencing this corpus drift family (sibling tickets: `returning-corpus-check-name-drift`, `sqllogic-error-directive-ordering`).
