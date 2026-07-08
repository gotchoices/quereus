description: A method that was supposed to return the SQL text of a statement instead returned the useless string "[object Object]"; now fixed to render real SQL.
files:
  - packages/quereus/src/core/statement.ts (getBlockSql, originalSql reconstruction — lines ~80, ~134)
  - packages/quereus/src/emit/ast-stringify.ts (astToString renderer; default-fallback NOTE added in review)
  - packages/quereus/test/statement-sql-text.spec.ts (regression coverage)
----

## What was wrong

`core/statement.ts` coerced AST statement nodes to strings via JS default
`Object.prototype.toString()`, yielding `"[object Object]"`, at two sites:

- `originalSql` reconstruction in the constructor (AST-batch path)
- the public `getBlockSql()` accessor (also feeds the planning debug log line
  transitively)

## Fix

Both sites now route through `astToString()` from `emit/ast-stringify.ts`,
the canonical AST→SQL renderer:

```ts
this.originalSql = this.astBatch.map(s => astToString(s)).join('; '); // constructor
return astToString(this.getAstStatement());                          // getBlockSql()
```

## Review findings

Adversarial pass over the implement diff (`f802df13`). Fix is correct,
minimal, and DRY (reuses the existing renderer rather than a new one).

**Checked:**

- **Correctness of both sites** — verified `astToString(AST.AstNode)` accepts
  and dispatches statement nodes; both edits compile and behave. ✅
- **Coverage claim** — re-confirmed the implementer's audit: `astToString`'s
  switch has an explicit case for all 27 `Statement` AST variants; none fall
  through to the `default` fallback. ✅
- **Boundary handling** — `getBlockSql()` guards `astBatchIndex` out-of-range
  → returns `""`; constructor handles empty batch. No new edge exposed. ✅
- **Tests** — 2 new specs cover both the SQL-string path (`getBlockSql()`) and
  the pre-parsed-AST-batch path (`originalSql`), each asserting real SQL and
  absence of `[object Object]`. Ran green. Added no per-statement-kind
  round-trip tests — `ast-stringify.ts` has its own dedicated round-trip
  suite; this ticket only needed to prove the two call sites are wired. ✅
- **Other stray `<astNode>.toString()` sites** (implementer's stated gap) —
  audited all `.toString()` calls across `packages/quereus/src`. The only
  ones on plan/AST-shaped objects are in planner-node debug output
  (`expr.toString()`, `node.toString()`); all 68 planner node classes define
  a custom `toString()`, so those render real descriptions, not
  `[object Object]`. The bug was specific to raw AST *statement* objects,
  which have no `toString()`. No other broken sites — no new ticket. ✅
- **Lint + full suite** — `yarn lint` clean; `node test-runner.mjs` →
  6434 passing, 9 pending (pre-existing skips), 0 failing.

**Fixed inline (minor):** the `default` fallback in `astToString` silently
returns `[${node.type}]` instead of throwing — a latent gap only if a *new*
`Statement`/`Expression` variant is ever added without a matching case (the
switch is not compiler-enforced exhaustive). Genuinely conditional →
recorded as a **tripwire**, not a ticket: added a greppable `NOTE:` comment
at the fallback site in `ast-stringify.ts` explaining the condition and the
remedy (make it throw) if it ever bites.

**Major / new tickets:** none.

**Blocked / decisions:** none.
