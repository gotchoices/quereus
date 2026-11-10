description: Declaring a statement parameter's type as ANY (through the type map `db.prepare` accepts) makes every non-null value bound to it fail with a type-mismatch error, so the "accept anything" declaration accepts only NULL.
files: packages/quereus/src/core/statement.ts, packages/quereus/src/types/builtin-types.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Declaring a parameter ANY is rare in practice — most callers let the bound value type the parameter — so this may sit behind more common parameter work.
----
# A parameter declared ANY rejects every non-null value

## Observed

```ts
const stmt = db.prepare('select k from t limit ?', new Map([[1, { typeClass: 'scalar', logicalType: ANY_TYPE, nullable: true, isReadOnly: true }]]));
for await (const r of stmt.iterateRows([2])) { … }
// Parameter type mismatch for ?1: expected ANY (physical: NULL), got value with physical type INTEGER
```

Binding `null` to the same statement is accepted. Seen while reviewing `bug-null-limit-returns-no-rows` (2026-11-10), whose prepare-time LIMIT check exempts exactly this kind of untyped parameter.

## Cause

`Statement.validateParameterTypes` (`packages/quereus/src/core/statement.ts`) compares the bound value's physical type with `expectedType.logicalType.physicalType`. `ANY_TYPE` declares `physicalType: PhysicalType.NULL` (`types/builtin-types.ts`), so only a NULL value matches. The type's own `validate` (which for ANY accepts every value) is never consulted.

## Expected

A parameter declared ANY accepts a value of any storage class; parameters declared with a concrete type keep today's check.
