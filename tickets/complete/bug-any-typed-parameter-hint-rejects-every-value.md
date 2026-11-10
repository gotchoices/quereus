description: Declaring a statement parameter's type as ANY (through the type map `db.prepare` accepts) made every non-null value bound to it fail with a type-mismatch error. ANY now skips the storage-class check.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/statement.ts, packages/quereus/test/parameter-types.spec.ts, docs/types-parameters.md
difficulty: easy
repro: verified
----
# ANY-typed parameter hint: skip the storage-class check

## What changed

- `Statement.validateParameterTypes` (`packages/quereus/src/core/statement.ts`): after the NULL branch, skips the physical-type comparison when the hint's logical type is the `ANY_TYPE` singleton. `ANY_TYPE` declares `physicalType: NULL` only as a placeholder, so before the fix only `null` matched. A non-nullable ANY hint still rejects `null` because the NULL branch runs first.
- `docs/types-parameters.md` § Type Checking and Validation: one line stating ANY accepts any storage class, and NULL only when nullable.
- Test `parameter-types.spec.ts` › "accepts a value of any storage class for an ANY-typed hint" reproduces the bug (threw MISMATCH before the fix).

Landed in `ticket(implement): bug-any-typed-parameter-hint-rejects-every-value`.

## Review findings

- **Correctness:** checked the ordering against the NULL branch (non-nullable ANY still rejects null) and that concrete types including `NULL_TYPE` keep the old comparison. Identity check against `ANY_TYPE` matches `row-count-expression.ts` and `value-provenance.ts`; inferred parameter types and user hints both carry the singleton, so identity is sufficient. No issue found.
- **Tests:** the new test is the bug's reproduction and pays for itself. No test added for non-nullable ANY rejecting null — that branch is unchanged code, not a new contract. Nothing cut.
- **Hygiene (minor, fixed):** hoisted the one remaining inline `await import('../src/types/builtin-types.js')` in `parameter-types.spec.ts` ("should work with explicit type hints") into the existing static import, per AGENTS.md.
- **Docs:** `docs/types-parameters.md` reflects the new behaviour; no other doc describes hint validation.
- **Major findings / tripwires:** none. The related null-first-binding issue is already tracked as `bug-null-first-binding-pins-parameter-to-null` in backlog.
- **Validation:** `yarn workspace @quereus/quereus test` — 11142 passing, 26 pending, 0 failing; `yarn workspace @quereus/quereus lint` — exit 0.
