description: Validate the `<q>` qualifier in `RETURNING <q>.*` through an updatable view (single- and multi-source) so a wrong qualifier errors like the base-table path instead of silently expanding to all view columns.
files:
  - packages/quereus/src/planner/mutation/single-source.ts   # assertReturningStarQualifier helper + rewriteViewReturning guard
  - packages/quereus/src/planner/mutation/multi-source.ts     # buildReturningProjection guard
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # coverage (named view, CTE-name, inline-subquery targets)
  - docs/sql.md                                               # RETURNING `view.*` qualifier-validation prose
----

# View `RETURNING <table>.*` qualifier validation — COMPLETE

## What shipped

A `RETURNING <q>.*` through an updatable view (single- or multi-source) now validates
the qualifier `<q>` against the view's effective name and raises the same diagnostic the
base-table path uses — `Table '<q>' not found in FROM clause for qualified RETURNING *`
— instead of silently expanding to all view columns for any qualifier.

The fix is a shared guard `assertReturningStarQualifier(rcTable, viewName)` exported from
`single-source.ts`, called at the top of the `rc.type === 'all'` branch in both
`rewriteViewReturning` (single-source) and `buildReturningProjection` (multi-source).
The qualifier is `view.name`, already in scope in both functions — for a named view it is
the view name; for an inline-subquery / CTE target the resolvers set `view.name` to the
user's correlation name (`resolveSubqueryTarget` → `source.alias`, `resolveCteTarget` →
`cte.name`), so the same single comparison is correct across all target shapes.

## Review findings

### Reviewed with fresh eyes against the base-table reference (`building/returning-star.ts`)

- **Helper correctness** — `undefined`/empty qualifier short-circuits (unqualified `*`
  unaffected); both sides lowercased; message string and `StatusCode.ERROR` are
  byte-identical to the base-table path. ✓
- **DRY** — single shared helper, message string single-sourced, imported by
  `multi-source.ts` alongside the existing `single-source.js` guard imports. ✓
- **No false rejection from the missing alias check** — the base-table path also accepts
  a table *alias* (`matchesAlias`); the view path checks only `view.name` and does not.
  Verified this is correct, not a gap: per `AST.UpdateStmt`/`DeleteStmt` docs,
  `UPDATE … AS x` reaches the AST **only** for an inline-subquery target, and for that
  target `view.name` *is* the user's alias. A named view / CTE target carries no separate
  user alias, so `view.name` is the one valid qualifier. ✓
- **Fixture/format hygiene** — new `qv_*` fixtures don't collide with any other sqllogic
  file; the `-- error: <substring>` directive matches the file's established convention. ✓

### Findings fixed inline (minor)

- **Missing coverage for the load-bearing design claim.** The implementer's tests covered
  only named single-/multi-source views. The whole fix rests on `view.name = correlation
  name` for inline-subquery and CTE-name targets, and *those* paths had no
  `RETURNING <q>.*` coverage. Added focused error + correct-qualifier cases to
  `93.4-view-mutation.sqllogic` for both:
  - CTE-name target (`with t as (…) update t … returning bogus.*` → error; `returning t.*`
    → expands), near the existing CTE-target RETURNING case.
  - Inline-subquery target (`update (select …) as v … returning bogus.*` → error;
    `returning v.*` → expands), near the existing inline-subquery RETURNING case.
  Both pass, confirming the resolvers thread the correlation name as designed.
- **Stale doc.** `docs/sql.md` RETURNING section stated the qualifier rule for the
  base-table path but only described view `*` *expansion*, not that a `view.*` qualifier
  must name the view (the old silent-any-qualifier behavior this ticket corrected). Added
  a clause stating the view qualifier must name the view (or, for an inline-subquery / CTE
  target, its correlation name).

### Findings deferred — no ticket warranted (minor, with reason)

- **Case-insensitive match untested.** `toLowerCase()` on both sides mirrors the
  base-table path exactly; the base path has the same gap. Not worth a dedicated case.
- **Multi-source inline-join target `RETURNING v.*` untested.** This is the same
  `buildReturningProjection` helper call site already covered by the named multi-source
  view tests, combined with the `view.name = alias` resolver path already covered by the
  single-source inline-subquery test added above. The intersection is a marginal
  combination with no distinct code path; covered transitively.

### No major findings

No new `fix/`/`plan/`/`backlog/` tickets filed — nothing surfaced that exceeds an
inline fix.

## Validation

- `93.4-view-mutation.sqllogic`: passes (named view + CTE-name + inline-subquery coverage).
- Full logic spec (`logic.spec.ts`, all 249 `.sqllogic` files): **249 passing**.
- `documentation.spec.ts`: **6 passing** (doc edit is prose; relative-link check still green).
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`): clean, exit 0.
- No pre-existing failures encountered.
