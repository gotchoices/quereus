---
description: Fixed and verified — a query grouping by two same-named columns from different tables (e.g. `group by i.id, c.id`) used to crash at plan time; it now groups correctly.
files:
  - packages/quereus/src/planner/scopes/registered.ts            # RegisteredScope — markAmbiguous / getAmbiguousSymbols
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope + HAVING hybrid-scope ambiguity copy
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # regression cases
---

# Complete: GROUP BY of two qualified same-base-name columns no longer crashes

## Summary

`GROUP BY i.id, c.id` (two qualified columns sharing a base name) crashed at plan
time with `Symbol 'id' already exists in the same scope.` The aggregate output
scope registered each GROUP BY output attribute under its bare lowercased name in a
flat `RegisteredScope`; the second `id` threw.

Fix mirrors source-side (FROM/JOIN) naming: register the **qualified** key
(`i.id`, `c.id`) so qualified references resolve distinctly, and register the
**bare** key only when unique — otherwise mark it ambiguous. A new
`RegisteredScope.markAmbiguous` records a key that `resolveSymbol` short-circuits
to `Ambiguous` before delegating to the parent, so a bare ambiguous reference
raises the clear "ambiguous column name" error instead of silently binding to a
pre-aggregate source column. The HAVING hybrid scope copies these marks so bare
ambiguity survives its source-column fallback. Entirely in the logical building
phase, so HashAggregate and StreamAggregate both inherit it.

## Review findings

Adversarial pass over commit `2813ac50`. Read the full diff and surrounding code
before the handoff summary.

**Verified — build/lint/tests all green (memory vtab, from `packages/quereus`):**
- `yarn build` — clean
- `node test-runner.mjs --grep "07.3-group-by-extras"` — 1 passing
- `yarn lint` — clean (eslint + test typecheck)
- `yarn test` — 6432 passing, 9 pending

**Correctness — checked, no defects found:**
- Duplicate-source-name crash does *not* resurface in HAVING: the source-column
  fallback loop in `buildHavingFilter` registers the first `id` and skips the
  second via its `alreadyRegistered` guard, so the two-`id` join no longer throws
  there. Confirmed by the qualified-HAVING regression case.
- Ambiguity is enforced at the right seams: the aggregate output scope holds the
  mark, so bare ambiguous refs in SELECT / ORDER BY resolve through it directly
  (that scope becomes `selectContext.scope` in `select.ts`), and HAVING copies the
  marks via `getAmbiguousSymbols()`. No scope path binds a bare ambiguous name to a
  pre-aggregate column.
- Degenerate `GROUP BY i.id, i.id` tolerated by identity-based owner counting
  (both keys share identity `i.id` → size 1 → not ambiguous); qualified/bare keys
  deduped via `registeredQualifiedKeys` / `registeredBareKeys`. Test covers it.
- `markAmbiguous` never routes through `registerSymbol`, so the old duplicate-throw
  cannot fire on the ambiguous path; `registerSymbol`'s throw stays as a genuine
  guard for other callers (unchanged).

**Test coverage — adequate as a floor:** happy path (exact repro over 3-table join
with left-join miss and bound param), qualified ORDER BY / HAVING, aliased
duplicate projection, degenerate duplicate key, negative bare-ambiguous HAVING,
and a single-table regression. Pre-existing bare `group by grp` cases still pass.

**Minor findings — none requiring a fix.** No inline fixes were needed.

**Major findings — none.** No new tickets filed.

**Tripwires / conditional (recorded here, not filed):**
- The HAVING source-column fallback loop re-registers a source column even for a
  key already marked ambiguous (e.g. source `id`). Harmless: `resolveSymbol`
  short-circuits to `Ambiguous` before consulting `registeredSymbols`, so the
  registration is dead weight, never a wrong bind. Not worth a code change.
- That same fallback loop calls `hybridScope.getSymbols()` once per source
  attribute — O(n²) in the source column count. **Pre-existing** (untouched by this
  diff), only matters for very wide sources; left as-is.
- Duplicate aggregate aliases (`count(*) as x, sum(a) as x`) now mark `x` ambiguous
  instead of throwing "Symbol already exists". This is an improvement (SQLite allows
  duplicate output aliases; a bare reference to `x` is legitimately ambiguous), not
  a regression. Untested but low risk.

**Deferred (implementer's call, upheld):** the ticket's optional point-1 message
enrichment of `registerSymbol`'s generic error was not done — out of the hot path;
the only remaining error path already yields the actionable `ambiguous column
name: id`.

**Adjacent, out of scope, confirmed not a regression:** projecting two *unaliased*
duplicate base names (`select i.id, c.id, count(*) ... group by i.id, c.id`) no
longer crashes and returns rows; duplicate output-column *naming* (`id` / `id:1`)
and `db.eval` row→object key collapsing are pre-existing behavior orthogonal to
this scope fix.

**Docs:** the change is an internal planner detail. `docs/runtime.md` mentions
`RegisteredScope` generically (pipeline description) and the "ambiguous column
name" error is already documented in `errors.md`/`sql.md` — both remain accurate.
No doc update required.
