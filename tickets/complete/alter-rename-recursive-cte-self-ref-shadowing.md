---
description: Pre-register recursive CTE names in scope before visiting their bodies so self-references aren't mistaken for the renamed table
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Summary

Fixes a recursive-CTE self-reference shadowing gap in the ALTER
TABLE RENAME COLUMN AST rewriter. Filed as a follow-up out of the
review of `alter-rename-propagation-cte-shadowing-renamed-table`.

In `pushWithFrame`, each CTE body was visited *before* its name was
added to `frame.ctesInScope`. Correct for non-recursive WITH (the
body must not see itself); wrong for `with recursive` (the body
must see itself, otherwise a `from <cte-name>` inside the recursive
step is misclassified as the renamed real table and column
rewriting corrupts the body).

## Change

`packages/quereus/src/schema/rename-rewriter.ts` — when
`withClause.recursive === true`, register each CTE's name in
`frame.ctesInScope` *before* visiting its body. Non-recursive WITH
keeps the existing ordering. The duplicate `add` after the body
visit is idempotent (Set semantics). Doc comment on
`pushWithFrame` calls out the recursive-vs-non-recursive invariant.

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` —
added sections 6j, 6k, and 6l (see Tests below).

## Tests

Three regression cases added to
`41.3-alter-rename-propagation.sqllogic`:

- **6j** — Recursive CTE named the same as the renamed table, **no
  explicit column list**, with a self-reference inside the recursive
  step.
- **6k** — Same shape with an explicit column list (`t_rec_cl(k)`).
  Worth noting: the column-list short-circuit only makes the CTE
  *non-exposing* — it does **not** skip body rewriting. The
  original fix-ticket claim that 6k "already passes today" was
  stale; without the fix 6k fails the same way 6j does.
- **6l** — Sibling recursive CTEs: `with recursive a as (...),
  t_rsib as (... from t_rsib ...)` where `t_rsib` is the renamed
  table. Guards that pre-registration happens per-iteration so a
  later sibling's body sees itself.

All three were verified to fail with `Column not found: kk` at
`packages/quereus/src/planner/resolve.ts:64` when the
pre-registration line is removed (stash-and-rerun confirmed).

## Validation

- `yarn workspace @quereus/quereus run test` → 3167 passing (~2m).
  No regressions.
- `yarn workspace @quereus/quereus run lint` → exit 0, silent.
- **Regression-guard verification:** edited `pushWithFrame` to
  comment out the pre-registration line and re-ran the 41.3 file.
  All of 6j, 6k, and 6l fail with the expected
  `QuereusError: Column not found: kk`. Restored the fix and
  reconfirmed clean pass.

## Review findings

### Source diff scrutiny

Re-read `pushWithFrame` and the surrounding `ScopeFrame` machinery
with fresh eyes before considering the implement-stage handoff.
The minimal one-line pre-registration is the right shape — it
preserves non-recursive semantics, is idempotent on the recursive
path, and matches what the body visitor needs (`isCteInScope`
walks the entire scope stack and only needs the name to be present
before body visit). No alternative formulation considered (e.g.
pre-registering all CTE names up-front) would be simpler or
clearer for the recursive case alone.

### `analyzeWithFrame` consistency (intentionally not changed)

The asymmetry between `pushWithFrame` (now recursive-aware) and
`analyzeWithFrame` (still adds names after each CTE's
exposure-check call) was probed for realistic-failure scenarios.
`analyzeWithFrame` is only invoked from `cteExposesRenamedColumn`
to rebuild a CTE body's *own* inner WITH frame for exposure
classification; it does not re-visit bodies. Walked through
nested `with outer_cte as (with recursive x as (...self-ref...)
...)` shapes — in every case, the body-visit correctness comes
from the outer `pushWithFrame`, and the inner-exposure
classification is unaffected because exposure analysis looks at
`select.from` / `select.columns` of the outer SELECT only (not
UNION arms), so the self-reference never reaches
`buildScopeFrame` via the inner rebuild. No failing case
constructed; leaving `analyzeWithFrame` alone keeps the diff
minimal. If a future case turns up, the one-line treatment ports
over.

### Test coverage

The implement-stage tests (6j, 6k) covered the canonical no-
column-list and with-column-list shapes. Added **6l** to close
the sibling-recursive gap the implementer explicitly flagged.
Did not add tests for `with recursive` inside UPDATE / DELETE —
all four call sites (`select` / `insert` / `update` / `delete` in
`visitColumnRename`) route through `pushWithFrame`, so the fix
carries; UPDATE/DELETE wouldn't exercise any code path the SELECT
case doesn't already cover for this specific bug.

### Latent qualified-ref bug discovered (filed separately)

While auditing `visitColumnRename`'s `column` case, found a
pre-existing correctness gap unrelated to recursion: when a
shadowing (non-exposing) CTE has the same name as the renamed
table and a query uses the CTE name itself as a qualifier (e.g.
`with t as (select 0 as k) select t.k from t` followed by `alter
table t rename column k to kk`), the `directHit` short-circuit
(`qualifierLower === state.tableName`) rewrites `t.k` to `t.kk`
without consulting scope. Test 6h sidesteps this by using an
alias (`from t_shadow2 as a` + `a.k`), which goes through
`aliasResolvesToTable` and is correctly suppressed by the
shadowing branch. Not introduced or regressed by this ticket;
filed as `tickets/fix/alter-rename-column-qualified-ref-to-
shadowing-cte.md`.

### Other checks (categories with no findings)

- **DRY / modularity:** pre-registration is one line in the
  natural place; no extracted helper warranted.
- **Resource cleanup / error handling:** `pushWithFrame`'s
  caller-pop contract unchanged; no new resources.
- **Type safety:** no `any`, no new types, all existing types
  reused.
- **Performance:** O(1) Set-add per CTE; net zero (the post-body
  add still runs and is idempotent).
- **Cross-platform:** AST-level rewrite; no platform-specific
  concerns.
- **Docs:** `docs/` does not reference rename-rewriter internals;
  the source doc-comment on `pushWithFrame` was updated by the
  implement stage to call out the invariant. No further doc
  updates needed.

## End
