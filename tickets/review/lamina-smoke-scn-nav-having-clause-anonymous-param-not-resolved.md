---
description: Fix for anonymous `?` (and named) parameters failing to resolve inside a post-aggregate HAVING clause; single-line scope-chain repair plus regression tests.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
---

# Review handoff — HAVING clause anonymous parameter resolution

## What was done

**Root cause:** `buildHavingFilter` in `select-aggregates.ts` (line 341) constructed
the hybrid scope with no parent:

```ts
const hybridScope = new RegisteredScope();   // broken
```

Because `RegisteredScope` only delegates `resolveSymbol` to `this.parent` when set,
the ancestor chain terminated at `hybridScope` — the `ParameterScope` that lives
higher up in `selectContext.scope` was never reached, so `resolveParameter` threw
`? isn't a parameter`.

**Fix (one line, `select-aggregates.ts:341`):**

```ts
const hybridScope = new RegisteredScope(selectContext.scope);   // fixed
```

`RegisteredScope.resolveSymbol` checks its own registered symbols first, so the
GROUP BY columns, aggregate aliases, and source-column fallbacks the function
registers still take priority. The parent is only reached for symbols the hybrid
scope doesn't know — parameters and qualified `table.column` refs.

The existing `findUngroupedColumnRef` guard is unchanged; it rejects bare
non-grouped column refs regardless of how they were resolved, so the looser
resolution path doesn't weaken that check.

## Tests added

`packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` — two new cases in a
new `hp` table block at the end of the file:

- **Anonymous `?`:** `having count(*) = ?` with params `[2]` — covers the bug report.
- **Named `:threshold`:** `having sum(val) > :threshold` with params `{"threshold":15}` — locks in the named-parameter code path.

## Test results

- `25.2-having-edge-cases.sqllogic`: 1 passing (154 ms)
- `02.1-bind-parameters.sqllogic`: 1 passing (168 ms)
- Full `yarn test`: **6405 passing, 9 pending, 0 failures**

## Known gaps / reviewer notes

- The `site-cad` caller that triggered the original report lives outside this repo
  and needs no change once the engine resolves the parameter correctly.
- No type-check run (`yarn lint`) was done; the fix is one symbol addition with no
  signature change and no new types, so drift is extremely unlikely — but the
  reviewer may wish to run it.
- Named-parameter resolution (`':name'` key) follows the same `resolveSymbol` path
  as `'?'`; the new test confirms it, but if named params use a different key format
  the second test case exercises that path.
