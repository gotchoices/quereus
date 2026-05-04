---
description: `42-returning.sqllogic:70,86` asserts substring `CHECK constraint failed: check_0` on an unnamed *column-level* CHECK, but the engine actually emits `_check_<column>` (e.g. `_check_positive_value`) for that authoring shape. The corpus wording is fictional — no code path produces `check_0` for column-level CHECK in CREATE TABLE. Tests pass cosmetically only because `INSERT … RETURNING` is pull-based (rows never materialise through `db.exec`, so the CHECK never fires) combined with the `executeExpectingError` tautology in `logic.spec.ts:564-588`. Same family as `sqllogic-error-directive-ordering`; distinct mechanism.
prereq:
files:
  - packages/quereus/test/logic/42-returning.sqllogic
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/runtime/emit/constraint-check.ts
  - packages/quereus/test/logic.spec.ts
---

# Corpus drift — `42-returning.sqllogic` CHECK error wording

## What the corpus asserts vs. what Quereus emits

`42-returning.sqllogic:58-86` (column-level unnamed CHECK):

```sql
CREATE TABLE test_constrained (
    id INTEGER PRIMARY KEY,
    positive_value INTEGER CHECK(positive_value > 0),
    name TEXT NOT NULL
);

INSERT INTO test_constrained (id, positive_value, name)
  VALUES (202, -5, 'invalid') RETURNING id, positive_value;
-- error: CHECK constraint failed: check_0
```

Direct test through `quereus/dist` (without RETURNING; same INSERT in isolation does fire the constraint):

```
ERROR: CHECK constraint failed: _check_positive_value (positive_value > 0)
```

`_check_positive_value` does not contain `check_0`. The test should fail. It cosmetically passes because of two compounding bugs.

## Why upstream cosmetically passes

### 1. `INSERT … RETURNING` is lazy under `db.exec`

`db.exec` does not iterate the projected RETURNING rows. Quereus's constraint pipeline runs as the rows are pulled, so when the rows are never pulled the CHECK never fires. Verified:

```
> INSERT INTO test_constrained VALUES (203, -10, 'x')
                                              RETURNING id, positive_value
NO ERROR FROM exec  (RETURNING is lazy)

> SELECT * FROM test_constrained
[]   ← row was not actually inserted; constraint pipeline starts
     iterating but no consumer drains it
```

The same INSERT *without* RETURNING throws as expected.

### 2. `executeExpectingError` tautology

Same as `sqllogic-error-directive-ordering`: `logic.spec.ts:564-588` `try`s `db.exec`, and on success **throws a new Error whose message contains the expected substring**, then catches it in the same handler and `.to.include`s the expected substring against the message it just synthesised. Substring match always passes when `db.exec` succeeded silently.

Combined: a no-error INSERT-RETURNING and a substring-tautology assertion mean the corpus's `check_0` wording was never actually compared against engine output.

## What the three naming paths actually produce

| Authoring                                        | Code site                                     | Default name format     | Example          |
|--------------------------------------------------|-----------------------------------------------|-------------------------|------------------|
| Column-level unnamed CHECK in CREATE             | `schema/manager.ts:639`                       | `_check_<column>`       | `_check_positive_value` |
| Table-level unnamed CHECK in CREATE              | `runtime/emit/constraint-check.ts:255-258`    | `_check_<index>`        | `_check_0`       |
| `ALTER TABLE … ADD CONSTRAINT CHECK(...)` unnamed| `runtime/emit/add-constraint.ts:38`           | `check_<index>`         | `check_0`        |

The corpus wording `check_0` matches only the **ALTER ADD** form (no underscore prefix), but the test's SQL is **column-level CHECK in CREATE**. Substring `check_0` would also coincidentally be contained in the table-level form `_check_0`, but the test SQL is not table-level either.

## Proposed changes

Two paths; pick whichever is preferable:

### Path A: Re-author the file (quick)

In `packages/quereus/test/logic/42-returning.sqllogic`, replace both occurrences of the substring `check_0` with `_check_positive_value` (or just `positive_value`, since it's a substring assertion):

```diff
 INSERT INTO test_constrained (id, positive_value, name)
   VALUES (202, -5, 'invalid') RETURNING id, positive_value;
--- error: CHECK constraint failed: check_0
+-- error: CHECK constraint failed: _check_positive_value
```

```diff
 UPDATE test_constrained SET positive_value = -1 WHERE id = 201
   RETURNING id, positive_value;
--- error: CHECK constraint failed: check_0
+-- error: CHECK constraint failed: _check_positive_value
```

### Path B: Make `db.exec` materialise RETURNING + fix the tautology

`db.exec` should drain RETURNING projections so that constraint violations on RETURNING-statements are not silently swallowed. Combined with the structural fix outlined in `sqllogic-error-directive-ordering` Path B (move the "executed-successfully" throw outside the try/catch in `executeExpectingError`), this would expose the `check_0` mismatch as a genuine failure and force Path A as a follow-up.

## Acceptance

- Either Path A (corpus rewording) or Path A + Path B (engine + corpus) lands. `42-returning.sqllogic` passes.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `RETURNING_CORPUS_CHECK_NAME_DRIFT` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry is removed. Lamina's runner already implements both behaviours (`packages/lamina-quereus-test/src/sqllogic/runner.ts:128-169`): prepares + iterates the final statement so RETURNING errors surface, and keeps the no-error throw outside the catch block.

## Notes

- Second known instance of the `executeExpectingError` tautology + a deferred error-emission path masking real corpus bugs; see `sqllogic-error-directive-ordering` for the first.
- `40-constraints.sqllogic` correctly asserts on `_check_pos`, `_check_bal`, `_check_status` (the authoritative column-level form), so changing the column-level default to `_check_<index>` to satisfy `42-returning` would break that file. Corpus-side correction is the only convergent fix.
