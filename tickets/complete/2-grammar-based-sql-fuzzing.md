description: Grammar-guided SQL fuzzer using fast-check for deep parser/planner/runtime coverage
files:
  - packages/quereus/test/fuzz.spec.ts
----

## What Was Built

A grammar-guided SQL fuzzer in `packages/quereus/test/fuzz.spec.ts` that generates syntactically valid SQL via `fc.letrec` and executes against the full engine pipeline (lexer → parser → planner → optimizer → emitter → runtime).

### Architecture

- **Schema generation**: Fresh `Database` with 1–3 tables, 2–5 typed columns each, optional constraints, seeded with 0–20 rows
- **SQL arbitraries via `fc.letrec`**: Mutually recursive generators for expressions (literals, column refs, binary/unary ops, functions, CASE, CAST, IN, BETWEEN), SELECTs (DISTINCT, JOINs, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT), compounds (UNION/INTERSECT/EXCEPT), CTEs, window functions, and DML (INSERT/UPDATE/DELETE with RETURNING)
- **No-crash invariant**: Execution must succeed or throw `QuereusError`; any other exception type is a test failure

### Test Cases (5 properties)

| Test | numRuns | Samples/run | Coverage |
|------|---------|-------------|----------|
| SELECT queries | 200 | 5 | Full SELECT pipeline including JOINs, aggregation |
| DML queries | 100 | 3 | INSERT/UPDATE/DELETE with RETURNING |
| compound/CTE queries | 100 | 4 | UNION/INTERSECT/EXCEPT + WITH...AS |
| window function queries | 100 | 3 | All window functions with frame specs |
| mixed workload | 200 | 5 | Random mix of all statement types |

### Review Fixes

- Removed unused `SCALAR_FUNCS` and `AGG_FUNCS` constants (dead code)
- Removed `beforeEach` that created a `Database` immediately leaked by property callbacks overwriting the variable
- Added `try/finally` around all property callback bodies to ensure `db.close()` on failure paths

### Performance

Full fuzzer suite runs in ~2 seconds. All 5 tests pass. Full project test suite passes.

### Usage

```bash
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/fuzz.spec.ts"
```
