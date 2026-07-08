description: When parsing fails, the parser sometimes throws away the original detailed error (including its location) and replaces it with a vaguer one, making syntax errors harder to diagnose.
files:
  - packages/quereus/src/parser/parser.ts (parseAll — around lines 106–119)
  - packages/quereus/src/common/errors.ts (QuereusError and subclasses, e.g. ParseError)
difficulty: easy
----

## Problem

In `parseAll` (`parser/parser.ts` ~106–119), the catch block decides whether an
exception is "one of ours" by comparing `e.name === 'QuereusError'`. But every
`QuereusError` subclass overrides `name` — a `ParseError` has `name === 'ParseError'`,
not `'QuereusError'`. So the guard fails for exactly the errors it is meant to
recognize: a `ParseError` (which already carries precise source location) is
treated as an unexpected/unhandled error, logged as such, and re-wrapped into a
new error that loses the subclass identity and the location information.

## Expected behavior

An already-typed engine error should propagate unchanged, preserving its subclass
and location. Replace the name comparison with an `instanceof` check:

```ts
if (e instanceof QuereusError) throw e;
```

Only genuinely foreign exceptions should be wrapped.

## Use case

Parsing a statement with a syntax error deep in the input should surface a
`ParseError` with the correct line/column, not a generic re-wrapped error with no
location.

## Edge cases

- Ensure the `QuereusError` symbol is imported in `parser.ts` for the `instanceof` check.
- Confirm no downstream code depends on the current (buggy) re-wrapping behavior for typed errors.
- A regression test: feed a mid-statement syntax error and assert the thrown error is a `ParseError` with populated location.
