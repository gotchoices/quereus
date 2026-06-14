description: Base-table INSERT/UPDATE/DELETE now support `RETURNING *` / `RETURNING <table>.*` by expanding the star in place over the existing OLD/NEW returning scope (the three `'RETURNING * not yet supported'` throws are gone). View / maintained-table / multi-source paths already supported it; this closed the base-table gap and added coverage + docs. Build, full memory suite (6259 passing), and lint are green.
files:
  - packages/quereus/src/planner/building/returning-star.ts          # NEW shared helper: expandReturningStar
  - packages/quereus/src/planner/building/insert.ts                  # base-table RETURNING build: throw → in-place star expansion (loop)
  - packages/quereus/src/planner/building/update.ts                  # same + per-column NEW attributeId coordination
  - packages/quereus/src/planner/building/delete.ts                  # same; star binds OLD (deleted image)
  - packages/quereus/src/planner/mutation/single-source.ts           # TODO comment: unvalidated <view>.* qualifier (pre-existing)
  - packages/quereus/src/planner/mutation/multi-source.ts            # TODO comment: same, on buildReturningProjection
  - packages/quereus/test/logic/42-returning.sqllogic               # line 16 now asserts the row; cascading verifies reconciled for id=102
  - packages/quereus/test/logic/42.1-returning-extras.sqllogic      # NEW sections 9/10/11: base-table RETURNING * cases
  - docs/sql.md                                                      # INSERT/UPDATE/DELETE grammar + §2.5.1 NEW/OLD image rule for *
difficulty: medium
----

# Review: `RETURNING *` for base-table INSERT / UPDATE / DELETE

## What shipped

The three base-table RETURNING builders rejected `*` / `t.*` with
`'RETURNING * not yet supported'`. They now expand the star **in place** over the
`returningScope` each builder already constructs, via a new shared helper
`expandReturningStar` (`building/returning-star.ts`):

- For `rc.type === 'all'`, it synthesizes one unqualified `{type:'column', name}`
  AST ref **per target column in declaration order** and runs each through the
  *same* `buildExpression`-over-`returningScope` path the named columns use. So
  the star automatically inherits the statement's default image — **NEW** for
  INSERT/UPDATE, **OLD** for DELETE (the unqualified symbol binds OLD in
  delete.ts) — and each column's declared type/collation, with **zero hand-built
  types**. Output names are the bare column names (`alias: tableColumn.name`),
  matching SELECT `t.*` parity.
- The three `.map(...)` calls became accumulating loops, so `*` expands in place:
  `returning id, *` and `returning *, name` keep surrounding items in position
  (duplicate output names de-dup to `name:1`, the existing ReturningNode rule).
- **Qualifier validation:** `t.*` is accepted when it matches the target table
  name (case-insensitive) or `stmt.alias` if present; otherwise it raises
  `Table '<x>' not found in FROM clause for qualified RETURNING *`
  (`StatusCode.ERROR`), mirroring `buildStarProjections`' SELECT shape. INSERT
  passes `undefined` alias (it has none; inline-subquery targets route to the
  view path before reaching here).
- **UPDATE only:** each expanded projection carries
  `attributeId = newColumnAttributeIds[columnIndex]`, matching the named path's
  NEW-attr coordination through optimization.
- `validateReturningQualifiers` is **not** called on the `all` branch (the helper
  never invokes it) — `*` carries no OLD/NEW qualifier and `rc.expr` does not
  exist on the `all` form. The named branches still validate (OLD-in-INSERT,
  NEW-in-DELETE) exactly as before.

The view / maintained-table / multi-source paths were **already** supporting `*`
(`rewriteViewReturning`, `buildReturningProjection`); no behavior change there —
only TODO comments added (see Decisions).

## Use cases to validate (the test floor — treat as a starting point)

Base-table coverage lives in `42.1-returning-extras.sqllogic` §9–11 and
`42-returning.sqllogic` line 16:

- `insert … returning *` → full row, declaration order, DEFAULT surfaced.
- `insert … returning star_t.*` → same as `*` (table-name qualifier).
- `insert … returning bogus.*` → `-- error: not found`, **no row inserted**.
- `update … returning *` → NEW (post-update) image.
- `update … returning *, name` and `update … returning id, *` → in-place expand
  with `name:1` / `id:1` de-dup.
- `update … returning old.value, *` → OLD-qualified expr composes with NEW `*`.
- `delete … returning *` → OLD (deleted) image.
- `update/delete … where 1=0 returning *` → `→ []` (no error).
- generated column + `DEFAULT 7` surfaced by `*` (§10).
- collated column: nocase WHERE matches and `*` returns the verbatim value (§11).
- relational orthogonality: `with ins as (insert … returning *) select count(*)…`
  and `with d as (delete … returning *) select … from d`.

View / maintained-table `RETURNING *` (already-working path, now exercised and
passing): `93.4-view-mutation.sqllogic` (single-source `greenmen2` line 2398;
multi-source join `rjoin` delete 2428, `dr_jv` delete-with-computed-column 2459,
`rjoin2` update 2505, `ojrv` 2760) and `53.1-materialized-view-write-through`
line 142 (MV delete `returning *`).

`42-returning.sqllogic` cascade: line 16 went from an expected error to the
returned row, so id=102 is now actually inserted — every downstream verify in
that table's lifecycle (the multi-row UPDATE RETURNING and the three `SELECT *`
checks at the old lines 23/31/35/43) was re-reconciled to include id=102. Worth a
careful re-read that none of those expectations was merely patched two-deep.

## Validation run

- `yarn workspace @quereus/quereus typecheck` (tsc --noEmit on src) — clean.
- `yarn workspace @quereus/quereus test` (memory suite) — **6259 passing, 9
  pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` (eslint + tsc on test files) — clean.
- Did **not** run `test:store` / `test:full` (per ticket; store-specific, slow).
  RETURNING * routes through the same base-table RETURNING machinery the store
  path already exercises, but a reviewer wanting belt-and-suspenders could run
  `yarn test:store` for `42*`/`93.4`/`53.1`.

## Decisions & known gaps (be adversarial here)

- **`<view>.*` qualifier is still unvalidated on the view path.** The view-path
  `all` branches (`single-source.ts`, `multi-source.ts`) expand all view columns
  regardless of `rc.table`, so `returning bogus.*` through a view silently
  expands rather than erroring. This is **pre-existing over-permissiveness**;
  tightening it needs the view name/alias threaded into both functions and is out
  of scope for a base-table-focused change. Left as-is, with a one-line TODO at
  each branch. No backlog ticket filed — reviewer's call whether it warrants one.
  (The **base-table** path *does* validate the qualifier — see the `bogus.*`
  test.)
- **Multi-source "no base term" diagnostic for `returning *` was NOT separately
  pinned.** `buildReturningProjection` raises `returning-through-view` when a view
  column has no base term, but a mutable join view's columns are recomputable: a
  literal/constant column (`99 as constc`) gets a trivial base term and `returning
  *` *succeeds* (verified via a scratch test — `update … returning *` returned the
  constant, did not raise). I could not construct a simple mutable join view whose
  `*` expansion is genuinely unrecoverable, so the branch reads as defensive. The
  positive multi-source `returning *` tests (incl. `dr_jv`'s computed `banner`,
  which recomputes) already exercise the expansion. If the reviewer knows a real
  unrecoverable-column shape, that would be the case to add.
- **Unrelated RETURNING-through-view rejections are unchanged** and still fire:
  multi-source *insert* (`multi-source.ts:3082`), set-op membership write
  (`set-op.ts`), decomposition / logical table (`decomposition.ts`), and
  outer-join existence-flag writes (`multi-source.ts`). None of these are
  base-table paths; the ticket did not touch them.
- **`returning *, *` (duplicate stars)** works (column set twice, de-duped names);
  not separately asserted (SQLite permits it; low value).

## Pointers

- The star machinery deliberately does **not** call `buildStarProjections`
  (the SELECT analog over a `RelationalPlanNode`'s attributes) — the DML returning
  scope is symbol-based, so resolution goes through the per-column registered
  symbol instead. See the helper's doc comment.
