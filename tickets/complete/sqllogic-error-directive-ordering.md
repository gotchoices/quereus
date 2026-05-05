---
description: Fixed the tautology in `executeExpectingError` (synthetic "executed successfully" throw was being self-consumed, so substring assertions passed by accident), reworked 11-joins.sqllogic ordering so the `-- error:` directive fires against the RIGHT JOIN SELECT instead of a buffered DROP, and renamed heading-style `-- Error:` comments in 03.5-tvf and 93-ddl-view-edge-cases to `-- expect error:` so the case-insensitive parser stops eating them as directives. Also closed four engine validation gaps unmasked by the structural fix.
files: packages/quereus/test/logic.spec.ts, packages/quereus/test/logic/11-joins.sqllogic, packages/quereus/test/logic/03.5-tvf.sqllogic, packages/quereus/test/logic/93-ddl-view-edge-cases.sqllogic, packages/quereus/test/logic/90-error_paths.sqllogic, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/runtime/emit/pragma.ts, packages/quereus/src/vtab/memory/layer/manager.ts
---

# Complete: sqllogic `-- error:` directive ordering

## Summary

The sqllogic `-- error:` directive matched its expected substring against the synthetic "Expected error matching X but SQL block executed successfully" message — so when SQL succeeded, the substring `X` happened to live verbatim in the error and the assertion passed by tautology. This silently masked real engine errors that should have been surfaced.

Two paths converged:

- **Path B (runner, `packages/quereus/test/logic.spec.ts:564-613`)**: rewrote `executeExpectingError` so the synthetic throw lives **outside** the catch and can't be self-consumed. Setup statements run in a batched `db.exec` (preserves multi-statement DML atomicity). Final statement is `db.prepare`d and drained via `iterateRows()` so SELECT-iteration errors (e.g. RIGHT JOIN unsupported) actually fire — `db.exec` does not consume SELECT iterators.

- **Path A (file ordering, `packages/quereus/test/logic/11-joins.sqllogic:32-46`)**: split the cleanup `DROP TABLE` from the RIGHT JOIN SELECT with a `-- run` directive so `currentSql` holds the SELECT (not the DROP) when the `-- error:` directive fires.

- **Heading rename (out-of-scope→in-scope)**: 8 capital-`-- Error:` heading comments in `03.5-tvf.sqllogic` and `93-ddl-view-edge-cases.sqllogic` matched the case-insensitive parser when `currentSql` was non-empty. Renamed to `-- expect error:` (doesn't match `startsWith('-- error:')`).

- **One wording mismatch (`90-error_paths.sqllogic:84`)**: test substring `subquery returned more than 1 row` updated to engine wording `subquery returned more than one row`.

## Engine validation gaps closed (unmasked by Path B)

1. **`CREATE TABLE` duplicate column name** (`schema/manager.ts:1186-1193`): `seenColumnNames` walk over `stmt.columns`; throws `Duplicate column name: <name>`.

2. **`PRAGMA name = value` on unknown pragma** (`runtime/emit/pragma.ts:16-30`): the silent no-op was a footgun and inconsistent with read-mode behavior; both modes now throw `Unknown pragma: <name>`.

3. **`CREATE UNIQUE INDEX` not enforcing uniqueness** (`schema/table.ts:217-226`, `schema/manager.ts:1062-1077`, `vtab/memory/layer/manager.ts:1239-1256`): added `unique?: boolean` to `IndexSchema`, populated from `stmt.isUnique`. Both catalog (`addIndexToTableSchema`) and layer (`vtab/memory/layer/manager.ts createIndex`) paths add a matching `UniqueConstraintSchema` so the existing mutation-manager enforcement picks it up — both update because the layer caches its own `tableSchema`.

4. **CHECK constraint determinism at CREATE TABLE** (`schema/manager.ts:880-919`): `validateCheckConstraintDeterminism` mirrors `validateDefaultDeterminism`. Walks the CHECK expression AST via `traverseAst` (using `enterNode` rather than `visitFunctionExpr` because the visitor's specific-key dispatch generates `visitFunction` from `node.type='function'`, which doesn't match the `AstVisitorCallbacks` interface key — minor visitor bug noted, out of scope here). Looks up each function call against the registry; throws if any function lacks `DETERMINISTIC`. Avoids the planning pipeline because CHECK column-ref scope isn't established at CREATE TABLE time.

## Validation

- `yarn build` — clean.
- `yarn test` — 2453 quereus tests pass; all other packages pass; 0 failing.
- `yarn workspace @quereus/quereus lint` — 0 errors, 275 pre-existing `any` warnings in test files (none on files touched by this ticket).
- Targeted regressions all pass:
  - `--grep "11-joins"` — RIGHT JOIN error now fires.
  - `--grep "10.1-ddl-lifecycle"` — duplicate column error fires at CREATE.
  - `--grep "103-database-options"` — PRAGMA write on unknown name throws.
  - `--grep "105-vtab-memory-mutation-kills"` — UNIQUE constraint enforced via unique index.
  - `--grep "44-determinism-validation"` — CHECK with `random()` / `date('now')` rejected at CREATE TABLE.
  - `--grep "04-transactions"` — multi-INSERT batch with mid-batch UNIQUE violation rolls back all rows (validates batched-setup behavior).

## Usage / how to write `-- error:` tests

A sqllogic block expecting an error has the form:

```
DROP TABLE foo;
-- run

SELECT * FROM unsupported_thing();
-- error: <substring expected in error message>
```

The runner now:

1. Splits the block on `;` into setup + final statement.
2. Runs setup statements together via `db.exec` (preserving multi-statement DML atomicity).
3. Prepares and drains the final statement via `iterateRows()` so generator-internal errors fire.
4. Asserts the caught error message contains the directive substring (case-insensitive).
5. Throws a fresh, *outside-the-try-catch* error if the block executed cleanly — the assertion can no longer pass by tautology.

Heading-style comments like `-- Error: not enough X` are non-directives; if you need to use that wording, use `-- expect error:` (anything that doesn't start with `-- error:`) so the parser doesn't pick it up.

## Downstream

Lamina's `lamina-quereus-test` package's `KNOWN_FAILURES` entry `SQLLOGIC_ERROR_DIRECTIVE_ORDERING` for `11-joins.sqllogic` can be removed once lamina consumes the new quereus version.

## Follow-up filed/considered (not bundled)

- Visitor module `visit${Type}` key inconsistency vs `AstVisitorCallbacks` interface (`visitFunctionExpr`) — file separately if useful.
- Whether `db.exec` should consume SELECT iterators — engine semantics question; the test runner now compensates at the test layer.
