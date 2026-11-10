description: If the first value given to a prepared statement's parameter was NULL, the statement rejected every non-null value given to that parameter afterwards. Now a parameter whose first value is NULL is typed ANY (accepts anything), as the maintainer decided; this review checks that change.
architecture: docs/types-parameters.md#type-resolution-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/type-utils.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
repro: verified
----
# A null first binding types the parameter ANY, not NULL — review handoff

## What was wrong

`getParameterScalarType` in `src/core/param.ts` typed a `null` parameter value through `inferLogicalTypeFromValue`, which returns NULL_TYPE. That type was frozen in `Statement.parameterTypes`, and `validateParameterTypes` then rejected every later non-null value ("expected NULL (physical: NULL), got value with physical type INTEGER"). `limit ?` prepared with `null` was rejected at prepare time and could never run with a real limit.

## What changed

- `src/core/param.ts` — `getParameterScalarType`: a `null` value now yields `ANY_TYPE`, `nullable: true`; non-null values keep the old inference with `nullable: false`. `inferLogicalTypeFromValue` is untouched (literal `null` stays NULL). Doc comments on this function and on `getParameterTypes` updated.
- `src/planner/type-utils.ts` — deleted the unused, divergent duplicate `getParameterScalarType` (grep over all `packages/*` found no caller) and its now-unused imports.
- `src/planner/building/row-count-expression.ts` — doc comment of `isUntypedParameter` only: an ANY parameter is either unbound at plan time or first bound to NULL; both go to the runtime `toRowCount` check. No logic change was needed — the existing ANY test already lets the parameter through.
- `src/core/statement.ts` — not changed. The parameter now has an entry in `parameterTypes`, so no re-plan happens when a non-null value arrives (as decided); `validateParameterTypes` accepts null because the type is nullable and skips the storage-class comparison for ANY.
- Docs: `docs/types-parameters.md` — inference table row `null → ANY (nullable)`; a note that `null` is the one exception to "shared with literal typing"; new subsection "A first binding of `null`" (end of "Type Resolution and Validation") stating the rule, no re-plan, hint map still wins, and the two consequences (no comparison-site coercion; LIMIT/OFFSET checked per execution); the "NULL compatibility" bullet now cross-references it. `docs/sql-select.md` §3.6 — the null-bound `limit ?` case moved from "Rejected when the statement is prepared" to "Checked on each execution".

## Tests

- `test/parameter-types.spec.ts` › "Parameter types are established from the first binding source" › "types a parameter first bound to NULL as ANY, so later non-null values are accepted" — the reproduction: `prepare('select ? as v', [null])`, then `get()` → `{v: null}`, `get([5])` → 5, `get(['x'])` → `'x'`, column type ANY.
- `test/runtime/early-stop-consumption.spec.ts` › "a NULL bound to the parameter raises at execution, before the first source row is pulled" — rewritten from the old prepare-time assertion; now expects `/LIMIT must not be NULL/` via `db.eval` and zero source rows read.
- Same file › "a statement first run with a NULL limit runs once rebound to a number" — one `db.prepare('… limit ?', [null])`, first `all()` fails with the runtime message, then `all([2])` returns `k = 1, 2`. Pins the "runtime check applies" consequence of the decision.

Validation run: `yarn workspace @quereus/quereus test` — 11145 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint` — clean (eslint + test-file type-check).

## Verified by hand (throwaway specs, deleted)

- ANY-comparison consequence documented in `types-parameters.md`: table `u(k integer primary key, n integer)` holding `(1, 5)`; `where n = ?` prepared with `[null]` then run with `['5']` returns nothing, run with `[5]` returns `k = 1`; the same SQL prepared with `['5']` (TEXT-typed) returns `k = 1`. Accepted cost per the decision — documented, not engineered around. Not pinned by a test (the ticket said not to).
- Existing asymmetry, unchanged by this ticket: a parameter first bound to a non-null value is typed non-nullable, so `prepare('select ? as v', [5])` then `get([null])` fails with "Parameter type mismatch for ?1: expected non-nullable INTEGER, got NULL". I documented it in the "NULL compatibility" bullet because it is the current behaviour, but it looks like the mirror image of this bug (e.g. `update t set x = ?` bound `5` then `null` would fail). Reviewer: decide whether that is intended or deserves its own ticket — the maintainer's decision covered only the null-first direction, so I did not change it.

## Things for the reviewer to look at

- `db.eval(sql, params)` / `db.get` with a `null` param now plan that parameter as ANY (they go through the same `getParameterTypes`, via `Database._buildProbeContext`). Behaviour for those one-shot paths changes the same way: `db.eval('… limit ?', [null])` now errors at runtime, not prepare time; a null-param comparison is unaffected in result (null compares to nothing either way).
- The `sqllogic` files `104-emit-mutation-kills.sqllogic` and `94.1-limit-offset-edge-cases.sqllogic` still expect "LIMIT expression may be NULL" — those use literal `null`, which still types NULL, and they pass.
