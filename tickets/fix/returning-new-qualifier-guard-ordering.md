----
description: The `NEW qualifier cannot be used in DELETE RETURNING clause` guard at `insert.ts:358-362` runs *after* the column-context resolution pass — so `DELETE FROM t WHERE id = 1 RETURNING NEW.id` fails with "No row context found for column id" instead of the intended NEW-qualifier guard message. The corpus's `90.3-expression-errors.sqllogic:41` asserts the guard wording. Tests pass cosmetically because of the tautology bug in `executeExpectingError` (see `sqllogic-error-directive-ordering`).
prereq:
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/runtime/context-helpers.ts, packages/quereus/test/logic/90.3-expression-errors.sqllogic
----

# DELETE RETURNING NEW qualifier guard ordering

## What the corpus asserts vs. what quereus produces

`90.3-expression-errors.sqllogic:36-41`:

```sql
CREATE TABLE t_del_ret (id INTEGER PRIMARY KEY, val INTEGER);
INSERT INTO t_del_ret VALUES (1, 10);
-- run

DELETE FROM t_del_ret WHERE id = 1 RETURNING NEW.id;
-- error: NEW qualifier cannot be used in DELETE RETURNING clause
```

The guard exists at `packages/quereus/src/planner/building/insert.ts:358-362`:

```typescript
if (e.table?.toLowerCase() === 'new' && operationType === 'DELETE') {
    throw new QuereusError(
        'NEW qualifier cannot be used in DELETE RETURNING clause',
        StatusCode.ERROR,
    );
}
```

— but it runs after the planner has already attempted to resolve `NEW.id` as a column reference. Resolution fails first, surfacing `packages/quereus/src/runtime/context-helpers.ts:188`:

```
No row context found for column id. The column reference must be evaluated within the context of its source relation.
```

Verified against pure quereus:

```
[E. RETURNING NEW guard]
  probe: delete from t_del_ret where id = 1 returning NEW.id
  expected substring: NEW qualifier cannot be used in DELETE RETURNING clause
  actual: No row context found for column id. The column reference must be evaluated within the context of its source relation.
```

## Why this exists

The RETURNING-clause expression walker resolves `NEW.x` / `OLD.x` as column references in a separate pass from the OLD/NEW-qualifier guard in `insert.ts:checkExpression`. The resolution pass evaluates first; the guard never gets a chance to fire.

Tests pass cosmetically because of the `executeExpectingError` tautology bug. See `sqllogic-error-directive-ordering` for the full write-up.

## Proposed changes

In `packages/quereus/src/planner/building/insert.ts` (and the parallel DELETE / UPDATE RETURNING-builder paths):

- Run `checkExpression` on every RETURNING-clause expression *before* the column-resolution pass. The guard at line 358 should be the first thing that touches NEW/OLD-prefixed column references in a DELETE / INSERT context.

- Equivalent fix for the symmetric INSERT RETURNING `OLD.x` guard at line 352 — a probe `INSERT INTO t VALUES (...) RETURNING OLD.id` presumably exhibits the same ordering bug today.

## Acceptance

`90.3-expression-errors.sqllogic` passes against quereus.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `RETURNING_NEW_GUARD_ORDERING` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry is removed.
