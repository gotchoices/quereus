----
description: Function dispatch does not reject calls whose argument count doesn't match any registered overload. The corpus's `10.3-function-features.sqllogic:79` asserts "Function not found" for `round(1.5, 2, 3)` — `round` is registered with `numArgs ∈ {1, 2}` only. Quereus today silently truncates / coerces extra args. Tests pass cosmetically because of the tautology bug in `executeExpectingError` (see `sqllogic-error-directive-ordering`).
prereq:
files: packages/quereus/src/core/database.ts, packages/quereus/src/func/builtins/scalar.ts, packages/quereus/test/logic/10.3-function-features.sqllogic
----

# Function arity / overload dispatch gap

## What the corpus asserts vs. what quereus produces

`10.3-function-features.sqllogic:69-83` asserts three flavours of arity mismatch:

```sql
-- Wrong number of args: abs() with too many args
select abs(1, 2);
-- error: Function not found

-- Wrong number of args: length() with no args
select length();
-- error: Function not found

-- Wrong number of args: round() with too many args
select round(1.5, 2, 3);
-- error: Function not found
```

`round` is registered in `packages/quereus/src/func/builtins/scalar.ts:72` with the standard `numArgs ∈ {1, 2}` overloads. `round/3` does not exist. The corpus expects the resolver to emit `Function not found:`. Quereus today **executes the statement successfully**, ignoring or coercing the extra argument.

Verified against pure quereus via a probe:

```
[C. round/3 arity]
  probe: select round(1.5, 2, 3)
  expected substring: Function not found
  actual: (none — executed successfully)
```

## Why this exists

`Database.registerFunction` keys the function registry by `(name, numArgs)`, but the dispatcher (somewhere in `core/database.ts` or the planner's expression-binding pass) does not reject lookups whose arity is absent from the registry — it likely falls back to the nearest-arity overload or accepts extras silently. Standard SQL (and SQLite, Postgres, MySQL) reject arity-mismatched calls.

Tests pass cosmetically because of the `executeExpectingError` tautology bug — see `sqllogic-error-directive-ordering`.

## Proposed changes

In `packages/quereus/src/core/database.ts` (or wherever the scalar function resolver lives):

- After lookup by `(name, numArgs)` returns `undefined`, throw:
  ```
  throw new QuereusError(
    `Function not found: ${name}/${numArgs}`,
    StatusCode.ERROR,
  );
  ```
  matching the wording the TVF dispatcher (per `tvf-error-message-wording`) is asked to emit.

- Apply the same check inside the planner's expression-binding pass so unresolved functions surface at plan time, not at row-projection time.

## Acceptance

`10.3-function-features.sqllogic` passes against quereus.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains a `FUNCTION_ARITY_VALIDATION` entry in its `KNOWN_FAILURES` list. After this lands and lamina consumes the new quereus version, that entry is removed.

## Notes

- `abs/2` and `length/0` in the same file have the same root cause; one change resolves all three asserts.
