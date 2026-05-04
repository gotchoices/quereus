----
description: `executeExpectingError` in `test/logic.spec.ts:564-588` has a tautology bug — its synthetic "Expected error matching X" message embeds X, so substring-match passes unconditionally even when the SQL succeeded. This masks several engine-side validation gaps (`tvf-error-message-wording`, `aggregate-grouping-validation`, `function-arity-validation`, `returning-new-qualifier-guard-ordering`) and a file-authoring bug in `11-joins.sqllogic` where an `-- error:` directive references a stale buffered DROP.
prereq:
files: packages/quereus/test/logic/11-joins.sqllogic, packages/quereus/test/logic.spec.ts
----

# Sqllogic `-- error:` runner tautology + file ordering bug

## The runner bug

`packages/quereus/test/logic.spec.ts:564-588`'s `executeExpectingError`:

```typescript
try {
    await db.exec(sqlBlock);
    const baseError = new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
    ...
    throw new Error(`${baseError.message}${diagnostics}`);
} catch (actualError: any) {
    expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(), ...);
}
```

The `catch` catches both the genuine engine error AND the synthetic "Expected error matching X" throw from the success branch. Because the synthetic message embeds `X`, the substring-match always passes. So tests cosmetically pass even when the SQL succeeded.

## How the bug surfaces

`11-joins.sqllogic:32-44`:

```sql
-- Multiple JOINs (requires a third table setup)
CREATE TABLE t_extra (id INTEGER PRIMARY KEY, right_id INTEGER, val_e TEXT);
INSERT INTO t_extra VALUES (100, 10, 'E1'), (200, 20, 'E2');
SELECT l.id, r.id, e.id FROM t_left l JOIN t_right r ON l.id = r.left_id JOIN t_extra e ON r.id = e.right_id ORDER BY l.id;
→ [{"id":1,"id:1":10,"id:2":100},{"id":2,"id:1":20,"id:2":200}]
DROP TABLE t_extra;

-- RIGHT JOIN (not supported yet)
-- error: RIGHT JOIN is not supported yet
SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;

DROP TABLE t_left;
DROP TABLE t_right;
```

When the runner reaches the `-- error:` directive on line 40, `currentSql` contains the buffered `DROP TABLE t_extra;` from line 37 — so `executeExpectingError` runs the DROP, which succeeds. A structurally correct runner reports:

```
[11-joins.sqllogic:40] Expected error containing "RIGHT JOIN is not supported yet" but SQL block executed successfully.
Block:
DROP TABLE t_extra;
```

The actual `RIGHT JOIN` SELECT then accumulates as setup and is run at end-of-file, where it does emit the expected `RIGHT JOIN is not supported yet`. The engine is fine; the file authoring is wrong.

The tautology bug masks both — the runner thinks the assertion passed.

## Proposed changes

Two paths; pick whichever is preferable:

### Path A: Re-author the file (quick)

In `packages/quereus/test/logic/11-joins.sqllogic`, fold the trailing DDL after each `→` block into the same accumulator:

```diff
SELECT l.id, r.id, e.id FROM t_left l JOIN t_right r ON l.id = r.left_id JOIN t_extra e ON r.id = e.right_id ORDER BY l.id;
→ [{"id":1,"id:1":10,"id:2":100},{"id":2,"id:1":20,"id:2":200}]
-DROP TABLE t_extra;
-
-- RIGHT JOIN (not supported yet)
+
+DROP TABLE t_extra;
+
+-- RIGHT JOIN (not supported yet)
+SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;
-- error: RIGHT JOIN is not supported yet
-SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;

DROP TABLE t_left;
```

i.e. flush the SELECT *before* the `-- error:` directive so `currentSql` holds the SELECT (not a stale DROP) when the directive fires.

### Path B: Fix the runner (correct)

In `packages/quereus/test/logic.spec.ts:564-588`, move the "executed-successfully" throw outside the try/catch:

```typescript
let actualError: Error | undefined;
try {
    await db.exec(sqlBlock);
} catch (e) {
    actualError = e as Error;
}
if (actualError === undefined) {
    throw new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
}
expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(), ...);
```

This is the structural fix. It will expose every other `.sqllogic` file with the same authoring bug and surface the engine-side gaps tracked in `tvf-error-message-wording`, `aggregate-grouping-validation`, `function-arity-validation`, and `returning-new-qualifier-guard-ordering` — turning each from "downstream-only failure" into a real upstream regression.

**Recommendation:** Path B. It's the structurally correct fix and gives a forcing function for the other four engine-side fixes.

## Acceptance

`11-joins.sqllogic` passes. If Path B is taken, the four engine-side tickets above also start failing (they should — fix them next).

## Downstream impact

Lamina's `lamina-quereus-test` package implements the structurally correct runner already (`packages/lamina-quereus-test/src/sqllogic/runner.ts:128-169`), which is why these gaps surface there first. Lamina maintains a `SQLLOGIC_ERROR_DIRECTIVE_ORDERING` entry in its `KNOWN_FAILURES` list for `11-joins.sqllogic`; after this lands and lamina consumes the new quereus version, that entry is removed.

## Notes

- The 8 capital-`Error:` heading comments in `03.5-tvf.sqllogic` and `93-ddl-view-edge-cases.sqllogic` are case-sensitive markers in the corpus convention. The current case-insensitive parser still treats them as assertions but the tautology bug masks the resulting "error". Worth a sweep while in this file.
