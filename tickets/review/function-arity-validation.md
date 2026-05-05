----
description: Function dispatch now correctly rejects calls whose argument count doesn't match any registered overload. The `round()` function was registered as variadic (numArgs=-1), which masked the existing arity check (since the dispatcher falls back to the variadic registration when the exact-arity lookup misses). Re-registered `round` as two explicit overloads (round/1, round/2) so `round(1.5, 2, 3)` now hits the "Function not found" path that abs/length already used.
files: packages/quereus/src/func/builtins/scalar.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/10.3-function-features.sqllogic
----

# Function arity validation

## What changed

The corpus's `10.3-function-features.sqllogic:69-83` asserts three flavours of arity mismatch should produce "Function not found":

- `select abs(1, 2);`
- `select length();`
- `select round(1.5, 2, 3);`

Probing pure quereus before the fix:
```
abs(1, 2)        → Function not found: abs/2          (already worked)
length()         → Function not found: length/0       (already worked)
round(1.5, 2, 3) → (executed without error)           ← BUG
```

`abs/2` and `length/0` already failed correctly because `abs` is registered as `numArgs: 1` and `length` as `numArgs: 1` — the planner-level resolver in `packages/quereus/src/planner/building/schema-resolution.ts:147` already throws `Function not found: ${funcName}/${numArgs}` when the exact-arity lookup misses **and** the variadic (`-1`) fallback also misses.

The `round(1.5, 2, 3)` case slipped through because `round` was registered with `numArgs: -1` (variadic). The dispatcher's variadic fallback caught `round/3` and dispatched to the variadic implementation, which silently ignored the extra argument.

The fix splits `round` into two explicit overloads (`round/1` and `round/2`) sharing one implementation function, eliminating the variadic registration. Now `round/3` falls through to the existing "Function not found" path.

## Files touched

- `packages/quereus/src/func/builtins/scalar.ts` — replaced `roundFunc` (numArgs=-1) with `roundImpl` + shared `roundSchemaBase` + two exports `roundFunc1` / `roundFunc2`.
- `packages/quereus/src/func/builtins/index.ts` — updated import and `BUILTIN_FUNCTIONS` entry to register both overloads.

## Validation

- `10.3-function-features.sqllogic` passes (the targeted assertion fires).
- All 2453 quereus tests pass.
- Lint clean (0 errors).
- Build clean.

## Reviewer checks

- Confirm the overload-pair pattern matches the precedent set by `pow`/`power` and `ceil`/`ceiling` (shared impl, separate `createScalarFunction` calls).
- Confirm no other code in the workspace still imports `roundFunc` (verified: only `roundFunc1`/`roundFunc2` references remain).
- Note the dispatcher logic in `packages/quereus/src/planner/building/schema-resolution.ts:140-152` was already correct — no planner-level change needed; the bug was purely in the registration of `round`.

## Out of scope (parked)

- `substr`/`substring` are also registered as `numArgs: -1` but conceptually only accept 2-3 args. No corpus assertion currently covers `substr/4`+, so leaving alone. If a future test fails for `substr(a, b, c, d)`, apply the same overload-split treatment.
- A general `minArgs`/`maxArgs` schema field would express bounded-variadic functions more cleanly, but adds complexity beyond the scope of this fix. Could be revisited if more functions need bounded arity.

## Downstream

Lamina's `lamina-quereus-test` `KNOWN_FAILURES` list contains a `FUNCTION_ARITY_VALIDATION` entry — once lamina consumes the new quereus version, that entry should be removed.
