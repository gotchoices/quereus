---
description: `executeExpectingError` in `test/logic.spec.ts:564-588` has a tautology bug — its synthetic "Expected error matching X" message embeds X, so the substring-match in the catch passes unconditionally even when the SQL succeeded. This masks engine-side validation gaps and a file-authoring bug in `11-joins.sqllogic` where an `-- error:` directive is preceded by a stale buffered `DROP TABLE`. Fix is structural: move the synthetic throw outside the try/catch, and re-author 11-joins so the SELECT (not the DROP) is what `currentSql` holds when the directive fires.
prereq: tvf-error-message-wording
files: packages/quereus/test/logic.spec.ts, packages/quereus/test/logic/11-joins.sqllogic
---

# Sqllogic `-- error:` runner tautology + 11-joins file ordering

## Context

`packages/quereus/test/logic.spec.ts:564-588`'s `executeExpectingError`:

```ts
try {
    await db.exec(sqlBlock);
    const baseError = new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
    const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
    throw new Error(`${baseError.message}${diagnostics}`);
} catch (actualError: any) {
    expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(), ...);
}
```

The `catch` block catches both the genuine engine error AND the synthetic "Expected error matching X" throw from the success branch. The synthetic message embeds `X` verbatim, so the substring-match always passes. Tests cosmetically pass even when the SQL succeeded.

`11-joins.sqllogic:32-44` has a separate authoring bug: line 37 `DROP TABLE t_extra;` accumulates into `currentSql` after the result-bearing block at line 35-36 resets state. When line 40 `-- error: RIGHT JOIN is not supported yet` fires, the runner runs the buffered DROP (which succeeds) and the synthetic throw is masked. The actual `RIGHT JOIN` SELECT then accumulates and is run at end-of-file via `executeSetup`, which raises the asserted error there — wrong line, wrong block.

## Approach

### Path B (runner fix) — `packages/quereus/test/logic.spec.ts`

Move the synthetic "executed-successfully" throw outside the try/catch so it can't be swallowed by its own catch:

```ts
const executeExpectingError = async (sqlBlock: string, errorSubstring: string, lineNum: number) => {
    if (TEST_OPTIONS.verbose) {
        console.log(`Executing block (expect error "${errorSubstring}"):\n${sqlBlock}`);
    }

    let actualError: Error | undefined;
    try {
        await db.exec(sqlBlock);
    } catch (e: any) {
        actualError = e instanceof Error ? e : new Error(String(e));
    }

    if (actualError === undefined) {
        const baseError = new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
        const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
        throw new Error(`${baseError.message}${diagnostics}`);
    }

    expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(),
        `[${file}:${lineNum}] Block: ${sqlBlock}\nExpected error containing: "${errorSubstring}"\nActual error: "${actualError.message}"`
    );

    const locationInfo = formatLocationInfo(actualError, sqlBlock);
    if (TEST_OPTIONS.verbose && locationInfo) {
        console.log(`   -> Error location: ${locationInfo}`);
    }
    if (TEST_OPTIONS.verbose) {
        console.log(`   -> Caught expected error: ${actualError.message}`);
    }
};
```

This is the structural fix.

### Path A (file fix) — `packages/quereus/test/logic/11-joins.sqllogic`

Re-author lines 32-44 so the SELECT under test is what's accumulated when the `-- error:` directive fires. Two adjustments:

- The line-37 `DROP TABLE t_extra;` is post-cleanup for the prior test; keep it but place it before the start of the next test block (after a blank line) so it's clearly setup.
- Place the `-- error:` directive *after* the SELECT so `currentSql` holds the SELECT.

Target shape:

```sql
-- Multiple JOINs (requires a third table setup)
CREATE TABLE t_extra (id INTEGER PRIMARY KEY, right_id INTEGER, val_e TEXT);
INSERT INTO t_extra VALUES (100, 10, 'E1'), (200, 20, 'E2');
SELECT l.id, r.id, e.id FROM t_left l JOIN t_right r ON l.id = r.left_id JOIN t_extra e ON r.id = e.right_id ORDER BY l.id;
→ [{"id":1,"id:1":10,"id:2":100},{"id":2,"id:1":20,"id:2":200}]

DROP TABLE t_extra;

-- RIGHT JOIN (not supported yet)
SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;
-- error: RIGHT JOIN is not supported yet

DROP TABLE t_left;
DROP TABLE t_right;
```

Note that `DROP TABLE t_extra;` is now setup-flushed via the next directive's `executeExpectingError` call, but on success the runner accumulates it into `currentSql` and only runs it when a result/error directive (or EOF) flushes — which in this layout is the `-- error:` directive on the next non-empty SQL line. Wrong: that would run `DROP TABLE t_extra;\nSELECT … RIGHT JOIN …` together expecting an error — the SELECT failure does dominate, so substring still matches, but the DROP no longer runs as a clean separate statement.

To keep the DROP isolated, insert a `-- run` directive after it:

```sql
DROP TABLE t_extra;
-- run

-- RIGHT JOIN (not supported yet)
SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;
-- error: RIGHT JOIN is not supported yet
```

`-- run` is already supported by the parser (`logic.spec.ts:714-720`) — flushes accumulated SQL as setup and resets state.

## Acceptance

- `11-joins.sqllogic` passes against the structurally-correct runner.
- Full `yarn test` passes (with prereq `tvf-error-message-wording` landed, `03.5-tvf.sqllogic`'s 5 TVF error assertions assert real wording and pass).
- `yarn workspace @quereus/quereus lint` clean.

## Out of scope

- The 8 capital-`-- Error:` heading comments in `03.5-tvf.sqllogic` and `93-ddl-view-edge-cases.sqllogic`. The case-insensitive parser treats them as `-- error:` directives, but they fire only when `currentSql` is empty (between blocks) and are immediately overwritten by the genuine `-- error:` line below — so they're harmless after Path B. A separate sweep can canonicalize the headings to a non-directive form (e.g. `-- expect error:` or just `-- ERROR_HEADING:`) but it's not required for this ticket.
- Other engine-side error wording / validation tickets (`returning-new-qualifier-guard-ordering`, `function-arity-validation`, `aggregate-grouping-validation`) — already landed.

## Downstream impact

Lamina's `lamina-quereus-test` package implements the structurally correct runner already (`packages/lamina-quereus-test/src/sqllogic/runner.ts:128-169`) and maintains a `SQLLOGIC_ERROR_DIRECTIVE_ORDERING` entry in its `KNOWN_FAILURES` list for `11-joins.sqllogic`; after this lands and lamina consumes the new quereus version, that entry is removed.

## TODO

- Apply Path B to `packages/quereus/test/logic.spec.ts:564-588`: extract `actualError` outside the try/catch, raise the synthetic "executed successfully" error only when no exception was caught, and assert substring containment on the captured error.
- Apply Path A to `packages/quereus/test/logic/11-joins.sqllogic:32-44`: place `DROP TABLE t_extra;` followed by `-- run`, then the RIGHT JOIN SELECT, then the `-- error:` directive (in that order).
- Run `yarn workspace @quereus/quereus mocha --grep "11-joins"` (or the package-local SQLLogic test target) to confirm `11-joins.sqllogic` passes.
- Run `yarn test` to confirm the full suite is green. If any other `.sqllogic` file surfaces a previously-masked authoring bug or engine-side wording gap, file a separate fix/ ticket; do not bundle.
- Run `yarn workspace @quereus/quereus lint` to confirm no lint regressions.
