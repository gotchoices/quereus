description: Review qualifier validation for `RETURNING <q>.*` through updatable views
files:
  - packages/quereus/src/planner/mutation/single-source.ts   # assertReturningStarQualifier helper + rewriteViewReturning fix
  - packages/quereus/src/planner/mutation/multi-source.ts     # buildReturningProjection fix
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # new coverage at end of file
----

## Summary

Added qualifier validation for `RETURNING <q>.*` through updatable views, matching the existing base-table diagnostic shape.

### Changes

**`single-source.ts`**
- Added `QuereusError` and `StatusCode` imports (previously absent).
- Exported a shared helper `assertReturningStarQualifier(rcTable, viewName)` that throws `Table '${rcTable}' not found in FROM clause for qualified RETURNING *` when the qualifier doesn't match the view name (case-insensitive comparison).
- Used the helper at the top of the `rc.type === 'all'` branch in `rewriteViewReturning`, removing the `TODO` comment.

**`multi-source.ts`**
- Imported `assertReturningStarQualifier` alongside the existing `guardTopLevelScope`/`assertTopLevelViewColumns` imports from `single-source.js`.
- Used the helper at the top of the `rc.type === 'all'` branch in `buildReturningProjection`, removing the `TODO` comment.

**`93.4-view-mutation.sqllogic`** (appended at end of file)
- New section "RETURNING <q>.* qualifier validation through updatable views" with:
  - Fresh `qv_men`/`qv_green` single-source filter view fixtures.
  - Error cases: single-source INSERT/UPDATE/DELETE with `returning bogus.*` → `not found in FROM clause for qualified RETURNING *`.
  - Regression cases: single-source INSERT/UPDATE/DELETE with `returning qv_green.*` → still expands correctly.
  - Fresh `qv_p`/`qv_c`/`qv_join` multi-source join view fixtures.
  - Error cases: multi-source UPDATE/DELETE with `returning bogus.*` → error.
  - Regression cases: multi-source UPDATE/DELETE with `returning qv_join.*` → still expands correctly.

### Test results

- Full test suite: **6274 passing, 9 pending** — no regressions.
- `yarn lint`: clean (exit 0).

## Use cases for testing / validation

1. **Wrong qualifier errors consistently** — `bogus.*` should fail with "Table 'bogus' not found in FROM clause for qualified RETURNING *" for all six mutation shapes (single-source INSERT/UPDATE/DELETE, multi-source UPDATE/DELETE).
2. **Correct qualifier still expands** — `<viewname>.*` through both single- and multi-source views should silently expand all view columns (the pre-fix behavior that must be preserved).
3. **Unqualified `*` still expands** — bare `RETURNING *` should continue to expand to all view columns (unchanged path, no qualifier to check).
4. **Case-insensitive match** — a qualifier spelled with mixed case matching the view name should be accepted (though no test explicitly covers this; the lowercased comparison mirrors the base-table path).

## Known gaps

- Case-insensitive match is asserted by code inspection only (no explicit test case for `RETURNING GREENMEN2.*` vs `returning greenmen2.*`). The base-table path has the same gap. Not worth a dedicated test given `toLowerCase()` on both sides.
- No test for inline-subquery / CTE-name targets (`update (select …) as v … returning v.*`). The ticket analysis says `view.name = source.alias` so the same guard applies, but those mutation paths have no dedicated sqllogic coverage here.
