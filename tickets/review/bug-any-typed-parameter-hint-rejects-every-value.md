description: Declaring a statement parameter's type as ANY (through the type map `db.prepare` accepts) made every non-null value bound to it fail with a type-mismatch error. ANY now skips the storage-class check; review the fix.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/statement.ts, packages/quereus/test/parameter-types.spec.ts, docs/types-parameters.md
difficulty: easy
repro: verified
----
# ANY-typed parameter hint: skip the storage-class check

## What changed

- `Statement.validateParameterTypes` (`packages/quereus/src/core/statement.ts`): after the NULL branch, a `continue` when `expectedType.logicalType === ANY_TYPE` (identity check against the singleton, the same way `row-count-expression.ts` does it). `ANY_TYPE` declares `physicalType: NULL` only as a placeholder, so before this change only `null` matched. The NULL branch still runs first, so a non-nullable ANY hint still rejects `null`. Concrete types, including `NULL_TYPE`, keep the existing comparison.
- `docs/types-parameters.md` § Type Checking and Validation: added a line to the physical-type compatibility list saying ANY accepts any storage class, and NULL only when the hint is nullable.

## Test added

- `parameter-types.spec.ts` › `Prepared Statement Type Validation` › "accepts a value of any storage class for an ANY-typed hint": prepares `select ? as v` with an ANY hint for `?1`, then checks that 2, `'x'` and 1.5 each come back unchanged. This is the reproduction; it threw a MISMATCH error before the fix. The new test imports `ANY_TYPE` statically at the top of the file. Older tests in the same describe still use inline `await import(...)`, which goes against AGENTS.md; I left them as they were.

## Validation

- `yarn workspace @quereus/quereus test`: 11142 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: exit 0.

## Known gaps / for the reviewer

- No test covers a non-nullable ANY hint rejecting `null`. The NULL branch did not change, so the existing behaviour carries over.
- The `limit ?` path with an ANY hint (the case where the bug was first seen) is not tested separately. The fix stage checked it by hand with a temporary patch of the same shape.
- Not addressed here: a parameter whose first binding is `null` gets pinned to the NULL type (tracked as `bug-null-first-binding-pins-parameter-to-null` in backlog).
