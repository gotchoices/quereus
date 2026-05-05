----
description: Code review for the fix that makes the NEW-in-DELETE-RETURNING and OLD-in-INSERT-RETURNING qualifier guards run before column resolution, so the planner reports the intended guard wording instead of a downstream "No row context found" error. Validation logic was extracted to a shared module, INSERT now uses the shared helper, and DELETE now invokes it.
prereq:
files: packages/quereus/src/planner/validation/returning-qualifier-validator.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/logic/90.3-expression-errors.sqllogic
----

# RETURNING NEW/OLD qualifier guard ordering — review

## Summary of change

Before this fix, `DELETE FROM t WHERE ... RETURNING NEW.id` failed with the runtime error `No row context found for column id...` because the DELETE builder never ran the qualifier guard — `NEW.id` resolved to a registered `new.<col>` symbol pointing at a NEW attribute that has no row context for DELETE. The guard `NEW qualifier cannot be used in DELETE RETURNING clause` lived only inside `insert.ts`'s `validateReturningExpression`, and was only invoked from the INSERT RETURNING path.

The fix:

- New shared helper `packages/quereus/src/planner/validation/returning-qualifier-validator.ts` exporting `validateReturningQualifiers(expr, op)`. It walks the AST and throws the appropriate `QuereusError` for `OLD.x` in INSERT or `NEW.x` in DELETE. Operates on the AST so it can run before any column-resolution / `buildExpression` pass.
- `packages/quereus/src/planner/building/insert.ts` — removed the private `validateReturningExpression` helper, imports `validateReturningQualifiers`, and calls it for each RETURNING projection (still before `buildExpression`, as it already was).
- `packages/quereus/src/planner/building/delete.ts` — imports `validateReturningQualifiers` and now calls it for each RETURNING projection before `buildExpression`. This is the actual bug fix; the INSERT change is just the refactor for shared use.
- UPDATE intentionally does not call the validator: both NEW and OLD are legal qualifiers in UPDATE RETURNING.

## Verification

- `yarn workspace @quereus/quereus build` — clean.
- `yarn lint` — 0 errors (warnings are pre-existing).
- Full quereus test suite (`yarn test`) — 2453 passing, 2 pending (no regressions).
- Direct probe against the built `dist/`:
  - `DELETE FROM t_del_ret WHERE id = 1 RETURNING NEW.id` → `NEW qualifier cannot be used in DELETE RETURNING clause` ✓
  - `INSERT INTO t_del_ret VALUES (2, 20) RETURNING OLD.id` → `OLD qualifier cannot be used in INSERT RETURNING clause` ✓

## Use cases / acceptance to re-check in review

- `90.3-expression-errors.sqllogic:36-41` — quereus now produces the asserted `NEW qualifier cannot be used in DELETE RETURNING clause` text. (Note: due to the runner tautology bug tracked separately in `sqllogic-error-directive-ordering`, this corpus file already passed cosmetically; this fix makes it pass on its merits, and against lamina's structurally correct runner.)
- `90.3-expression-errors.sqllogic:27-29` — `INSERT INTO ... RETURNING OLD.id` continues to produce `OLD qualifier cannot be used in INSERT RETURNING clause` (was already correct; behavior preserved through refactor).
- UPDATE RETURNING with both `NEW.x` and `OLD.x` continues to work normally — verify no regression by exercising existing UPDATE RETURNING tests.

## Review checklist

- The new validator is a pure AST walker with no scope/context dependency — confirm it's the right scope of behavior (it should only refuse the two illegal pairings; everything else passes through).
- Subquery / EXISTS expressions are deliberately not traversed — the comment in the validator notes this. Confirm this matches expectations (qualifier inside a subquery references the subquery's own scope, not the outer DML).
- The INSERT path's behavior is identical to before the refactor — same guard, same call site relative to `buildExpression`, same scope object.
- The DELETE path now calls the validator inside `stmt.returning.map(...)` before `buildExpression`. Worth confirming this is the right place (it is — same pattern as INSERT).
- No new ESLint warnings introduced.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `RETURNING_NEW_GUARD_ORDERING` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry can be removed.
