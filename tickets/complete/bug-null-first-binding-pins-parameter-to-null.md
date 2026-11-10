description: If the first value given to a prepared statement's parameter was NULL, the statement rejected every non-null value given to that parameter afterwards. Now a parameter whose first value is NULL is typed ANY (accepts anything), as the maintainer decided.
architecture: docs/types-parameters.md#type-resolution-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/type-utils.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
repro: verified
----
# A null first binding types the parameter ANY, not NULL

## Summary

`getParameterScalarType` (`src/core/param.ts`) typed a `null` parameter value as NULL. That type was frozen in the statement's parameter types, so every later non-null value failed validation, and `limit ?` prepared with `null` was rejected at prepare time with no way to run it later. It now types a `null` value ANY, nullable; non-null values keep the old inference (non-nullable). Literal `null` still types NULL (`inferLogicalTypeFromValue` is unchanged). No re-plan happens when a non-null value arrives later. The unused duplicate `getParameterScalarType` in `src/planner/type-utils.ts`, which had drifted from the real one, was deleted. `docs/types-parameters.md` gained the subsection "A first binding of `null`" (the rule; a hint map still wins; no comparison-site coercion; LIMIT/OFFSET checked per execution). `docs/sql-select.md` §3.6 moved the null-bound `limit ?` case to "Checked on each execution".

Landed in `ticket(implement): bug-null-first-binding-pins-parameter-to-null`.

Tests: `test/parameter-types.spec.ts` "types a parameter first bound to NULL as ANY, so later non-null values are accepted" (the reproduction); `test/runtime/early-stop-consumption.spec.ts` "a NULL bound to the parameter raises at execution, before the first source row is pulled" and "a statement first run with a NULL limit runs once rebound to a number".

## Review findings

Checked: the implement diff (all source, test and doc hunks); `Statement.establishParameterTypes`, `hasUntypedBinding`, `dropStalePlanOnBind` and `validateParameterTypes` in `src/core/statement.ts` against the new type; `isUntypedParameter` in `src/planner/building/row-count-expression.ts`; every `logicalType === ANY_TYPE` consumer in `src/`; and that the deleted `type-utils.ts` function had no callers. Ran a throwaway probe spec (deleted): null first, then non-null, for `select ? is null`, `coalesce(?, 7)`, `? + 1`, `insert … values (?, ?)` and `where x = ?` against an integer column. All returned correct results, with no mismatch and no re-plan. `yarn workspace @quereus/quereus test`: 11145 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint`: clean.

- **Correctness / happy path / edge cases:** no defects found. The parameter now has an entry in the type map, so no re-plan fires. Null is accepted because the type is nullable, and non-null values skip the storage-class comparison for ANY.
- **Major — reachable mirror-image defect (pre-existing, not introduced here):** a parameter first bound to a non-null value is typed non-nullable, so a reused `update t set x = ?` statement rejects a later NULL ("expected non-nullable INTEGER, got NULL"; verified). The maintainer's decision covered only the null-first direction. Fixing this changes the LIMIT/OFFSET prepare-time check and possibly optimizer non-null facts, so it needs a design decision. Filed to `blocked/nullability-of-value-inferred-parameter-types` with a recommended rule (value-inferred types are nullable) and the alternatives.
- **Minor — fixed inline:** the `isUntypedParameter` doc comment named only "unbound" and "first bound to NULL" as the ways a parameter can be ANY; a hint map that declares ANY is a third, now listed. The `getParameterTypes` doc comment said `number (integer) → INTEGER` / `number (float) → REAL`, which predates the safe-integer split; it now matches `docs/types-parameters.md`.
- **Docs:** read `docs/types-parameters.md` and `docs/sql-select.md` §3.6 in full around the change; both reflect the new behaviour. The "NULL compatibility" bullet now states the (undecided) rejection of NULL after a non-null first binding. Left as is because it accurately describes current behaviour until the blocked ticket is decided. The sqllogic files that expect "LIMIT expression may be NULL" use literal `null`, which still types NULL, and they pass.
- **Tests:** each of the three added or rewritten tests pins a stated behaviour: the reproduction, the runtime LIMIT check before any source row is read, and rebinding after a NULL limit. Kept all three and added none. The ANY-comparison consequence (`where n = ?` with null first, then `'5'`, returns nothing) is documented but untested, as the plan directed.
- **Type safety / DRY / hygiene:** no `any`. Removing the duplicate in `type-utils.ts` improves DRY. No resource-cleanup or error-handling paths are touched.
- **Performance:** unchanged — no new compile or allocation per bind.
- **Tripwires:** none recorded; nothing conditional found.
