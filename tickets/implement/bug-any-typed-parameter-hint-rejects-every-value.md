description: Declaring a statement parameter's type as ANY (through the type map `db.prepare` accepts) makes every non-null value bound to it fail with a type-mismatch error, so the "accept anything" declaration accepts only NULL. Make ANY skip the storage-class check.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/statement.ts, packages/quereus/src/types/builtin-types.ts, packages/quereus/test/parameter-types.spec.ts, docs/types-parameters.md
difficulty: easy
repro: verified
----
# A parameter declared ANY rejects every non-null value

## Reproduction (verified 2026-11-10)

```ts
const anyHint = { typeClass: 'scalar', logicalType: ANY_TYPE, nullable: true, isReadOnly: true } as ScalarType;
const stmt = db.prepare('select ? as v', new Map([[1, anyHint]]));
await stmt.get([2]);
// QuereusError: Parameter type mismatch for ?1: expected ANY (physical: NULL), got value with physical type INTEGER
```

`null` is accepted; integer, text and real values all throw. The same happens with `select k from t limit ?`, which is how it was first seen (while reviewing `bug-null-limit-returns-no-rows`, whose prepare-time LIMIT check exempts exactly this kind of ANY-typed parameter in `planner/building/row-count-expression.ts`).

## Cause

`Statement.validateParameterTypes` (`packages/quereus/src/core/statement.ts`, the loop over `this.parameterTypes`) compares `getPhysicalType(value)` with `expectedType.logicalType.physicalType`. `ANY_TYPE` (`types/builtin-types.ts`) declares `physicalType: PhysicalType.NULL` as a placeholder, because it has no single storage class, so only a NULL value matches. Nothing consults the fact that ANY accepts every value (`validate: () => true`).

## Fix

In that loop, after the NULL branch and before the physical-type comparison, skip the storage-class check when the declared type is ANY. Test identity against the singleton (`expectedType.logicalType === ANY_TYPE`, importing `ANY_TYPE` from `../types/builtin-types.js`), matching `row-count-expression.ts` and `isNumericArgType`. The NULL branch stays as is, so a non-nullable ANY hint still rejects `null`. Concrete types keep today's check unchanged.

A temporary patch of exactly this shape was tried during the fix stage and then reverted. With it, the downstream plan handles the value correctly: `select ? as v` returns 2, `'x'` and 1.5; `limit ?` with 2 returns two rows; `limit ?` with `null` still raises the separate runtime "LIMIT must not be NULL" error; `where k = ?` with 2 finds the row.

Don't generalize this to "any type whose `physicalType` is NULL". `NULL_TYPE` also declares NULL, and for it the check is correct: it really does admit only null.

## Related, not in this ticket

If the first value bound to an un-hinted parameter is `null`, the parameter's type becomes NULL and stays that way, so any later non-null value for it is rejected (`db.prepare('select ? as v', [null])`, then `stmt.get([5])` → "expected NULL (physical: NULL)"). This fails at the same comparison, but the fix there is a separate design choice: whether a `null` binding should count as setting the parameter's type at all. Filed as `tickets/backlog/bug-null-first-binding-pins-parameter-to-null.md`. Do not fold it in here.

## TODO

- In `validateParameterTypes` (`src/core/statement.ts`), add the ANY skip between the NULL branch and the physical-type comparison, with a one-line comment saying ANY has no single storage class.
- Add one test to the `Prepared Statement Type Validation` describe in `packages/quereus/test/parameter-types.spec.ts`: prepare `select ? as v` with an ANY hint for `1`, then confirm that an integer, a string and a real each round-trip. This is the reproduction.
- In `docs/types-parameters.md` § Type Checking and Validation, add a line to the "Examples of physical type compatibility" list: a parameter declared ANY accepts a value of any storage class, and NULL only if the hint is nullable.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
