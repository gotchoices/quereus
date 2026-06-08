---
description: Made the ALTER TABLE ADD COLUMN NOT-NULL-without-DEFAULT failure assertion in the logic corpus explicit, removing dependency on the `default_column_nullability` database option.
prereq:
files:
  - packages/quereus/test/logic/41-alter-table.sqllogic
---

# Complete: explicit NOT NULL on alter-table corpus assertion

## What changed

`packages/quereus/test/logic/41-alter-table.sqllogic:131` — the NOT-NULL-without-DEFAULT failure case now declares the constraint explicitly:

```sql
alter table t_notnull add column required text not null;
-- error: NOT NULL
```

Previously the column declared no nullability and relied on the Quereus default `default_column_nullability = 'not_null'` (Third Manifesto) to upgrade implicit nullability. That made the corpus assertion drift under downstream consumers (e.g. lamina) that override the option to `'nullable'` (SQL standard) — the alter would succeed, the `-- error: NOT NULL` assertion would fail, and the test would break for an environmental reason rather than a real semantics regression.

## Why this is correct

- Matches the inline comment ("NOT NULL without DEFAULT should fail").
- Removes the assertion's dependency on a configurable database option.
- Internally consistent with line 142, which is already explicit (`not null default 'default_val'`).
- `executeExpectingError` is already structured outside the surrounding try/catch (per `sqllogic-error-directive-ordering`), so the no-error throw was never tautological — the assertion now also passes for a portable reason.

## Verification

- `node packages/quereus/test-runner.mjs --grep "41-alter-table"` → 1 passing.
- `yarn workspace @quereus/quereus test` → 2453 passing, 2 pending, 0 failing.
- Corpus-wide grep for `add column \w+ text;` followed by `-- error:` surfaces only line 30 (`-- error: already exists`, testing duplicate-column detection — unrelated to nullability). No other corpus assertions depend on `default_column_nullability`.

## Files

- `packages/quereus/test/logic/41-alter-table.sqllogic` — single one-line edit at line 131.

No source code changes; no doc updates required (the behaviour of `default_column_nullability` is documented and unchanged).

## Downstream

Lamina can now drop its `ALTER_TABLE_NOT_NULL_CORPUS_DRIFT` known-failure entry once the next Quereus pull lands.
