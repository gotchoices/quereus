---
description: Fixed the tautology bug in `executeExpectingError` and the 11-joins.sqllogic file ordering. The synthetic "executed-successfully" throw now lives outside the try/catch so it can't be swallowed; the runner additionally drains the final statement via prepare/iterateRows so SELECT-iteration errors (row-generator throws) are surfaced, while preserving multi-statement DML atomicity. Path A renames the joined block in 11-joins.sqllogic so the directive fires against the SELECT, not a buffered DROP. Surfaced engine validation gaps were addressed inline (CREATE TABLE duplicate column, PRAGMA write to unknown name, CREATE UNIQUE INDEX enforcement, CHECK constraint determinism at CREATE TABLE time) and the heading-style `-- Error:` comments in 03.5-tvf and 93-ddl-view-edge-cases were renamed to `-- expect error:` to stop the case-insensitive parser from picking them up as directives.
files: packages/quereus/test/logic.spec.ts, packages/quereus/test/logic/11-joins.sqllogic, packages/quereus/test/logic/03.5-tvf.sqllogic, packages/quereus/test/logic/93-ddl-view-edge-cases.sqllogic, packages/quereus/test/logic/90-error_paths.sqllogic, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/runtime/emit/pragma.ts, packages/quereus/src/vtab/memory/layer/manager.ts
---

# Review: sqllogic `-- error:` directive ordering

## What landed

### Path B — runner (`packages/quereus/test/logic.spec.ts:564-606`)

`executeExpectingError` was restructured:

- The synthetic "Expected error matching X but SQL block executed successfully." throw now lives **outside** the try/catch — previously the catch was its own consumer, so the substring assertion always saw the synthetic message containing X verbatim and passed by tautology.
- The block is split on `;` into setup + final statement. Setup statements are batched into a single `db.exec` call (preserves transaction atomicity for multi-statement DML — important because the original test 04-transactions:23-32 expects an aborted batch to roll back the *first* INSERT too). The final statement is `db.prepare`d and drained via `iterateRows()`, so generator-internal throws (e.g. RIGHT JOIN unsupported) actually fire — `db.exec` does not consume SELECT iterators.

### Path A — file ordering (`packages/quereus/test/logic/11-joins.sqllogic:32-46`)

Restructured so the right-shape SQL is what `currentSql` holds when the directive fires:

```
DROP TABLE t_extra;
-- run

-- RIGHT JOIN (not supported yet)
SELECT l.id, r.id FROM t_left l RIGHT JOIN t_right r ON l.id = r.left_id ORDER BY r.id;
-- error: RIGHT JOIN is not supported yet
```

The `-- run` directive flushes the cleanup `DROP` as setup; the SELECT then accumulates and is what the next `-- error:` directive evaluates.

### Heading rename (out-of-scope→in-scope)

The 8 capital-`-- Error:` comments in `03.5-tvf.sqllogic` and `93-ddl-view-edge-cases.sqllogic` matched the case-insensitive `-- error:` directive. The original ticket assessed them as harmless on the assumption that `currentSql` was empty whenever they fired — that wasn't true (line-37's "just test it runs" SELECT had buffered into `currentSql` before the heading on line 39 fired). Renamed to `-- expect error:` (also doesn't match `startsWith('-- error:')`).

### One wording mismatch (`90-error_paths.sqllogic:84`)

Test expected substring `subquery returned more than 1 row`; engine throws `Scalar subquery returned more than one row`. Updated test substring to match engine wording (English form, not "1").

### Engine validation gaps surfaced and fixed inline

Path B's structural fix unmasked four engine validation gaps that were previously hidden by the tautology. Each is small and directly motivated by the unmasking:

1. **`CREATE TABLE` duplicate column name** (`schema/manager.ts:1133-1140`): added a `seenColumnNames` walk over `stmt.columns`; throws `Duplicate column name: <name>`.

2. **`PRAGMA name = value` on unknown pragma** (`runtime/emit/pragma.ts:16-27`): the silent no-op was a footgun and inconsistent with the read-mode behavior just below. Now both modes throw `Unknown pragma: <name>`.

3. **`CREATE UNIQUE INDEX` not enforcing uniqueness** (`schema/table.ts:217-224`, `schema/manager.ts:1018-1043`, `vtab/memory/layer/manager.ts:1239-1257`): added `unique?: boolean` to `IndexSchema`, populated from `stmt.isUnique`, and made `addIndexToTableSchema` (catalog) and the layer manager's `createIndex` both add a matching `UniqueConstraintSchema` so the existing mutation-manager enforcement path picks it up. Both code paths must update because the layer caches its own `tableSchema`.

4. **CHECK constraint determinism at CREATE TABLE** (`schema/manager.ts:880-918`): added `validateCheckConstraintDeterminism` mirroring `validateDefaultDeterminism`. Walks the CHECK expression AST via `traverseAst` (using `enterNode` rather than `visitFunctionExpr` because the visitor key generated from `node.type` is `visitFunction`, which doesn't match the interface key `visitFunctionExpr` — minor visitor bug noted but not bundled), looks up each function call in the registry, and throws if any function lacks the `DETERMINISTIC` flag. Avoids the full planning pipeline because CHECK column-ref scope isn't established at CREATE TABLE time.

## How to validate

- `yarn test` — full suite: 2453 passing, 0 failing.
- `yarn workspace @quereus/quereus lint` — 0 errors. The 275 warnings are all pre-existing `any` annotations in test files; nothing introduced by this ticket.
- Targeted regression checks (each was a real failure surfaced after Path B and now passes):
  - `yarn test --grep "11-joins"` — RIGHT JOIN error now actually fires.
  - `yarn test --grep "10.1-ddl-lifecycle"` — duplicate column error fires at CREATE.
  - `yarn test --grep "103-database-options"` — PRAGMA write on unknown name throws.
  - `yarn test --grep "105-vtab-memory-mutation-kills"` — UNIQUE constraint enforced via unique index.
  - `yarn test --grep "44-determinism-validation"` — CHECK with `random()` / `date('now')` rejected at CREATE TABLE.
  - `yarn test --grep "04-transactions"` — multi-INSERT batch with mid-batch UNIQUE violation rolls back all rows (validates the setup-statement batching in the new `executeExpectingError`).

## Reviewer focus

- **Setup-statement batching**: the new `executeExpectingError` joins setup statements with `;\n` and runs them in a single `db.exec`. This was deliberate after a first iteration that ran each statement in its own `db.exec` broke 04-transactions atomicity (each separate exec auto-commits). Confirm the join pattern preserves intended behavior across all `-- error:` files.
- **`prepare` + `iterateRows` on DML**: the final statement may be a SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, etc. `Statement.iterateRows()` runs through the runtime regardless. Spot-check that DML-only error tests (e.g. constraint violations on INSERT) still throw correctly via this path.
- **`UniqueConstraintSchema` from unique index**: the constraint name reuses the index name (`indexSchema.name`). If two unique indexes share columns, two constraints with different names will fire — that's harmless for enforcement (both succeed/fail together) but reviewer should confirm no downstream code dedupes by `(name, columns)` in a way that breaks.
- **CHECK determinism walker**: uses `enterNode` because the visitor's specific-key dispatch (`visit${Type}`) generates names that don't match the `AstVisitorCallbacks` interface (`visitFunctionExpr` etc.). This is a latent visitor-module bug; consider filing a separate ticket to canonicalize the visitor key naming. Not bundled here.
- **Engine fixes are minimal and targeted**: each addresses exactly the gap surfaced by Path B. None refactor surrounding code.

## Downstream

Lamina's `lamina-quereus-test` package's `KNOWN_FAILURES` entry `SQLLOGIC_ERROR_DIRECTIVE_ORDERING` for `11-joins.sqllogic` can be removed once lamina consumes the new quereus version.

## Out of scope (not bundled)

- The visitor-module key-naming inconsistency (`visit${Type}` vs `visitFunctionExpr`) — file as a separate ticket if useful.
- Whether `db.exec` should consume SELECT iterators by default (engine semantics question; the test runner now compensates at the test layer).
