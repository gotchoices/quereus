description: If the first value given to a prepared statement's parameter is NULL, the statement rejects every non-null value given to that parameter afterwards. Per the maintainer's decision, a parameter whose first value is NULL should be typed ANY (accepts anything) instead.
architecture: docs/types-parameters.md#type-resolution-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/type-utils.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
repro: verified
----
# A null first binding types the parameter ANY, not NULL

## Reproduction (verified 2026-11-10, throwaway mocha spec, since deleted)

```ts
const stmt = db.prepare('select ? as v', [null]);
await stmt.get();      // { v: null }
await stmt.get([5]);   // Parameter type mismatch for ?1: expected NULL (physical: NULL), got value with physical type INTEGER

const s2 = db.prepare('select ? as v');
s2.bindAll([null]); await s2.get();
await s2.get(['x']);   // same mismatch, physical type TEXT

db.prepare('select value from generate_series(1, 10) limit ?', [null]);
// first execution: "LIMIT expression may be NULL; wrap it in coalesce(…), or omit the clause instead" (prepare-time rejection),
// and the statement can never be run with limit 2 afterwards
```

## Cause

`getParameterScalarType` in `packages/quereus/src/core/param.ts` maps a value through `inferLogicalTypeFromValue` (`common/type-inference.ts`), which returns `NULL_TYPE` for `null`. That type enters `Statement.parameterTypes` through `establishParameterTypes` (`core/statement.ts`) and is frozen there. `validateParameterTypes` then compares every later non-null value against NULL's physical type, which nothing matches. The same function also feeds `Database._buildProbeContext` (`db.eval(sql, params)` / `db.get`), so those paths type a null parameter NULL too.

## Decision (maintainer, 2026-11-10)

A parameter with no declared type whose first bound value is NULL is typed **ANY, nullable**. No re-plan when a non-null value arrives later: the plan built on the null binding stays, and ANY accepts whatever comes next. A declared type map (`db.prepare(sql, Map)`) still wins — this only affects inference from values.

## Fix

- In `core/param.ts` `getParameterScalarType`: when `value === null`, use `ANY_TYPE` (from `types/builtin-types.js`) with `nullable: true`; otherwise keep the current inference (and `nullable: false`). Do **not** change `inferLogicalTypeFromValue` — it is shared with literal typing, where `null` must stay NULL. Update the inference-rule list in the function's doc comment (`null → ANY (nullable)`).
- Nothing else in `statement.ts` should need to change: the parameter now has an entry in `parameterTypes`, so `hasUntypedBinding` / `dropStalePlanOnBind` will not re-plan (as decided), and `validateParameterTypes` already skips the storage-class comparison for ANY (landed with `bug-any-typed-parameter-hint-rejects-every-value`) and accepts null because the type is nullable.
- LIMIT / OFFSET: `isUntypedParameter` in `planner/building/row-count-expression.ts` already lets an ANY parameter through to the runtime `toRowCount` check (`util/row-count.ts`), so `limit ?` prepared with `null` will now plan, fail at execution with "LIMIT must not be NULL; omit the clause instead", and run fine when later bound to `2`. Update that function's doc comment: an ANY parameter is either unbound at plan time or first bound to NULL; in both cases its value is left to the runtime check.
- `planner/type-utils.ts` has a second, unused `getParameterScalarType` (no callers in `src/` — confirm with a grep, including other packages). Delete it rather than leave a divergent copy (DRY).

## Behaviour changes to be aware of

- `test/runtime/early-stop-consumption.spec.ts` "a NULL bound to the parameter is rejected when the statement is prepared" asserts the old prepare-time message `/LIMIT expression may be NULL/` for `db.eval('select k from counting limit ?', [null])`. It will now fail at runtime with `/LIMIT must not be NULL/`. Rewrite that test to the new behaviour (still asserting zero source rows read — the runtime check runs before the source is pulled), and rename it accordingly.
- `docs/sql-select.md` §3.6 (around line 821, "Rejected when the statement is prepared") states "`limit ?` planned with `null` bound is rejected". Change it: a parameter first bound to `null` is typed ANY and so is checked on each execution (move it under "Checked on each execution" beside "a parameter that is still untyped").
- A null-first parameter compared against a typed column (`where int_col = ?`, later bound `'5'`) plans as ANY, so it gets ANY's comparison behaviour rather than the column-affinity conversion a TEXT- or INTEGER-typed parameter would get. That is the accepted cost of the decision; state it in the docs, don't engineer around it.

## Tests (keep to these)

- `test/parameter-types.spec.ts`, in describe "Parameter types are established from the first binding source": one test — `prepare('select ? as v', [null])`; `get()` → `{ v: null }`; then `get([5])` → 5 and `get(['x'])` → `'x'` on the same statement; `getColumnDefs()[0].type.logicalType.name` is `'ANY'`. This is the reproduction.
- The rewritten early-stop LIMIT test above, plus in the same test (or right after) that the same prepared `limit ?` statement first run with `null` then runs with `2` and returns 2 rows — pins the "runtime check applies" consequence from the decision. Use `db.prepare` for that part since `db.eval` doesn't reuse a statement.
- No test for the declared-map precedence; it is an existing, separately tested branch (`parameterTypesDeclared`).

## TODO

- Change `getParameterScalarType` in `core/param.ts` (null → ANY nullable) and its doc comment.
- Delete the unused duplicate in `planner/type-utils.ts` after confirming no callers.
- Update the `isUntypedParameter` doc comment in `planner/building/row-count-expression.ts`.
- Add the reproduction test to `test/parameter-types.spec.ts`.
- Rewrite the null-LIMIT test in `test/runtime/early-stop-consumption.spec.ts` to the runtime-rejection behaviour, plus the rebind-to-2 check.
- `docs/types-parameters.md`: inference table row `null` → `ANY (nullable)`; under "Type Resolution and Validation" add the rule — a first binding of `null` types the parameter ANY (nullable) for the statement's life, no re-plan when a non-null value later arrives, a declared type map still wins, and the ANY-comparison consequence. Also fix the line under "Type Checking and Validation" that says NULL is compatible with any nullable parameter type if it needs a cross-reference.
- `docs/sql-select.md` §3.6: move the null-bound `limit ?` case from prepare-time rejection to per-execution check.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
