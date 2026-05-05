---
description: Review the one-line corpus fix to `41-alter-table.sqllogic:131` that makes the NOT NULL alter-table assertion explicit and portable across `default_column_nullability` settings. Sibling of `returning-corpus-check-name-drift` and `sqllogic-error-directive-ordering` in the corpus-drift family.
prereq:
files:
  - packages/quereus/test/logic/41-alter-table.sqllogic
---

# Review: explicit NOT NULL on alter-table corpus assertion

## Change

`packages/quereus/test/logic/41-alter-table.sqllogic:131` — the NOT-NULL-without-DEFAULT failure case now writes the constraint explicitly:

```sql
alter table t_notnull add column required text not null;
-- error: NOT NULL
```

Previously the column declared no nullability and relied on `default_column_nullability = 'not_null'` (Quereus default, Third Manifesto) to upgrade the implicit nullability — which made the assertion drift under downstream consumers that override the option to `'nullable'` (SQL standard).

## Why this is correct

- Matches the comment ("NOT NULL without DEFAULT should fail").
- Removes dependency on a database option for a constraint-semantics test.
- Internally consistent with line 142, which is already explicit (`not null default 'default_val'`).
- Path B (the `executeExpectingError` no-error-throw) was already structured outside the surrounding try/catch by `sqllogic-error-directive-ordering`, so the assertion was never tautological in current Quereus — it now also passes for a portable reason.

## Verification

- `node packages/quereus/test-runner.mjs --grep "41-alter-table"` → 1 passing.
- `yarn workspace @quereus/quereus test` → 2453 passing, 2 pending, no failures.
- Corpus-wide grep for the original `add column \w+ text;` followed by `-- error:` pattern surfaces no other instances.

## Review focus

- Confirm the corpus edit at line 131 is the only change.
- Sanity-check there's no other `alter table ... add column ... ;` in the logic corpus that depends on `default_column_nullability` for its assertion.
- No code changes; no doc updates required (the behaviour of `default_column_nullability` is documented and unchanged).

## Downstream

Once consumed, lamina can drop its `ALTER_TABLE_NOT_NULL_CORPUS_DRIFT` known-failure entry.
