----
description: Regression test added for the refill-path arity guard in importMaterializedView — twin of the existing adopt-path arity test.
files:
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts
----

## What was done

Added one new `it(...)` test to `packages/quereus-store/test/mv-rehydrate-adopt.spec.ts` immediately after the existing adopt-path arity test (line ~253). The new test is titled:

> `'refill-path twin: a declared-column arity mismatch errors per-entry without dropping the backing'`

It exercises the refill path (stale-at-close MV, marker names it) with a declared-arity mismatch (`mv (a, b)` vs a 3-column body), confirming all four required expectations:

1. Exactly one per-entry rehydration error matching `/2 declared columns but body produces 3/i`
2. No maintained-table record (`getMaintainedTable` undefined)
3. Backing still registered as a plain table (`getTable` defined)
4. Sentinel row preserved in the physical store (DROP never happened)

No production code changes were needed — the fix was already landed in `maintained-table-unified-model`.

## Test results

- 536 tests passing (includes the new test)
- Typecheck: clean

## Use cases for validation

- The key behavioral difference from the adopt-path twin: the session-2 `alter table src add column w` marks mv stale-at-close. `closeAll` writes a marker naming mv. Session 3's `reopen()` routes via the REFILL branch (not the adopt fast path). The arity guard (`assertDeclaredColumnArity`) fires ABOVE the `dropTable` call in `importMaterializedView`, so the backing is preserved.
- A future refactor that moves `assertDeclaredColumnArity` to after the `dropTable` call would cause this test to fail while the adopt-path twin remains green — the exact regression the ticket was designed to catch.

## Known gaps

None — scope was a single regression test only. Post-drop runtime failures (duplicate key, row-time eligibility) remain untested per the ticket's explicit scope decision.
