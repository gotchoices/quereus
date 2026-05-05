----
description: NEW-in-DELETE-RETURNING and OLD-in-INSERT-RETURNING qualifier guards now run on the AST before column resolution, producing the intended guard wording instead of a downstream "No row context found" error. The validator was extracted to a shared module and is now invoked from both INSERT and DELETE.
files: packages/quereus/src/planner/validation/returning-qualifier-validator.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/logic/90.3-expression-errors.sqllogic
----

# RETURNING NEW/OLD qualifier guard ordering — complete

## What was built

- `packages/quereus/src/planner/validation/returning-qualifier-validator.ts` — new module exporting `validateReturningQualifiers(expr, op)`. Pure AST walker, no scope/context dependency. Throws `QuereusError` for `OLD.x` in INSERT or `NEW.x` in DELETE; everything else passes through.
- `packages/quereus/src/planner/building/insert.ts` — removed the private `validateReturningExpression` helper, now calls the shared `validateReturningQualifiers` for each RETURNING projection before `buildExpression`.
- `packages/quereus/src/planner/building/delete.ts` — now calls `validateReturningQualifiers` for each RETURNING projection before `buildExpression`. This is the actual bug fix; before, DELETE never invoked the qualifier guard, so `NEW.id` resolved to a registered `new.<col>` symbol pointing at a NEW attribute with no row context, producing the runtime error `No row context found for column id`.
- UPDATE intentionally does not call the validator: both NEW and OLD are legal qualifiers in UPDATE RETURNING.

## Review-stage adjustment

Review found that the validator (and the pre-refactor helper it replaced) skipped `BetweenExpr`, leaving a hole where `RETURNING (NEW.id BETWEEN 1 AND 10)` in DELETE bypassed the guard and surfaced the original "No row context found" error — the very symptom the ticket targets. Added a `between` arm that recurses into `expr`, `lower`, and `upper`. Verified by direct probe:

- `DELETE FROM t WHERE id = 1 RETURNING (NEW.id BETWEEN 1 AND 10)` → `NEW qualifier cannot be used in DELETE RETURNING clause` ✓
- `INSERT INTO t VALUES (5, 50) RETURNING (OLD.id BETWEEN 1 AND 10)` → `OLD qualifier cannot be used in INSERT RETURNING clause` ✓

Subquery / EXISTS expressions are deliberately not traversed — qualifier scoping inside a subquery is independent of the outer DML operation, and the validator comment notes this.

## Verification

- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/quereus lint` — 0 errors (warnings are pre-existing).
- `yarn test` — 2453 passing, 2 pending (no regressions).
- Direct probes against built `dist/`:
  - `DELETE ... RETURNING NEW.id` → `NEW qualifier cannot be used in DELETE RETURNING clause` ✓
  - `INSERT ... RETURNING OLD.id` → `OLD qualifier cannot be used in INSERT RETURNING clause` ✓
  - `DELETE ... RETURNING (NEW.id BETWEEN 1 AND 10)` → `NEW qualifier cannot be used in DELETE RETURNING clause` ✓
  - `INSERT ... RETURNING (OLD.id BETWEEN 1 AND 10)` → `OLD qualifier cannot be used in INSERT RETURNING clause` ✓

## Test corpus

`packages/quereus/test/logic/90.3-expression-errors.sqllogic`:

- Lines 36–41 — `DELETE ... RETURNING NEW.id` now produces the asserted guard text on its own merits (was previously cosmetically passing through a runner tautology bug tracked in `sqllogic-error-directive-ordering`).
- Lines 27–29 — `INSERT ... RETURNING OLD.id` continues to produce the asserted guard text; behavior preserved through the refactor.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `RETURNING_NEW_GUARD_ORDERING` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry can be removed.
