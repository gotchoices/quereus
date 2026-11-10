description: If the first value given to a prepared statement's parameter is NULL, the statement rejects every non-null value given to that parameter afterwards, so a statement first run with a missing value can't be reused with a real one.
architecture: docs/types-parameters.md#type-resolution-and-validation
files: packages/quereus/src/core/statement.ts, packages/quereus/src/core/param.ts, docs/types-parameters.md
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Treating a null binding as "not typed yet" means a plan built on that binding has to be thrown away and compiled again once a real value arrives, which is an extra compile and adds another case to the parameter-typing rules.
----
# A null first binding fixes the parameter's type as NULL

## Observed (2026-11-10)

```ts
const stmt = db.prepare('select ? as v', [null]);
await stmt.get();      // { v: null }
await stmt.get([5]);   // Parameter type mismatch for ?1: expected NULL (physical: NULL), got value with physical type INTEGER
```

## Why

A parameter's type comes from the first value bound to it and never changes after that (docs/types-parameters.md § Type Resolution and Validation). `getParameterTypes` (`core/param.ts`) infers NULL from a `null` value. `Statement.validateParameterTypes` (`core/statement.ts`) then requires every later non-null value to have NULL's storage class, which no non-null value can have. The documented inference table lists `null → NULL` but never says that this locks the parameter to null for the rest of the statement's life, and nobody would want that.

## Expected

A parameter whose only binding so far has been `null` still accepts a later non-null value. The value that arrives then gives the parameter its type, the same way a first binding does today.

## Open design point

A `null` binding could be treated as "no type yet": the parameter stays untyped and the existing rule "a plan built without a parameter's type is discarded when it is first bound" handles recompiling. Or the parameter could be typed ANY. ANY avoids the recompile but gives up the precise type that later values would have supplied. The first option matches what the doc already promises for parameters that have no type yet. Note: once `bug-any-typed-parameter-hint-rejects-every-value` lands, the bind-time check accepts any value for an ANY-typed parameter.

## Decision (maintainer, 2026-11-10)

A parameter with no declared type whose first bound value is NULL is typed ANY (nullable), not "not typed yet". No re-plan or rebinding when a non-null value arrives later: the plan built on the null binding stays, and ANY accepts whatever comes next. The maintainer wants where a parameter's type gets fixed to stay clear, which a deferred re-type would blur.

Consequences to pin with tests: later non-null values of any type bind and run on the same plan; places that need a typed value at run time (for example the LIMIT/OFFSET runtime check for ANY parameters from `bug-null-limit-returns-no-rows`) apply their runtime checks. A declared type (the `db.prepare` type map) still wins over this rule. Document the rule beside the existing parameter-typing description.
