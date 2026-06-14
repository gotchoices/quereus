description: Base-table INSERT/UPDATE/DELETE now support `RETURNING *` / `RETURNING <table>.*` by expanding the star in place over the existing OLD/NEW returning scope (the three `'RETURNING * not yet supported'` throws are gone). Reviewed and accepted; one follow-up backlog ticket filed for view-path qualifier validation.
files:
  - packages/quereus/src/planner/building/returning-star.ts          # shared helper: expandReturningStar
  - packages/quereus/src/planner/building/insert.ts                  # base-table RETURNING build: in-place star expansion
  - packages/quereus/src/planner/building/update.ts                  # same + per-column NEW attributeId coordination
  - packages/quereus/src/planner/building/delete.ts                  # same; star binds OLD (deleted image)
  - packages/quereus/src/planner/mutation/single-source.ts           # TODO: unvalidated <view>.* qualifier (pre-existing)
  - packages/quereus/src/planner/mutation/multi-source.ts            # TODO: same, on buildReturningProjection
  - packages/quereus/test/logic/42-returning.sqllogic               # line 16 asserts the row; cascade reconciled for id=102
  - packages/quereus/test/logic/42.1-returning-extras.sqllogic      # §9/10/11 base-table RETURNING * cases + multi-row interaction (review)
  - docs/sql.md                                                      # INSERT/UPDATE/DELETE grammar + §2.5.1 NEW/OLD image rule for *
----

# Complete: `RETURNING *` for base-table INSERT / UPDATE / DELETE

## What shipped

The three base-table RETURNING builders previously rejected `*` / `t.*` with
`'RETURNING * not yet supported'`. They now expand the star **in place** over the
`returningScope` each builder already constructs, via the shared helper
`expandReturningStar` (`building/returning-star.ts`):

- `rc.type === 'all'` synthesizes one unqualified `{type:'column', name}` AST ref
  per target column in declaration order, each resolved through the *same*
  `buildExpression`-over-`returningScope` path the named columns use. The star
  inherits the statement's default image — **NEW** for INSERT/UPDATE, **OLD** for
  DELETE — and each column's declared type/collation, with zero hand-built types.
  Output names are the bare column names (SELECT `t.*` parity).
- The three `.map(...)` calls became accumulating loops, so `*` expands in place
  (`returning id, *` / `returning *, name` keep surrounding items in position;
  duplicate output names de-dup to `name:1` via the existing ReturningNode rule).
- **Qualifier validation:** base-table `t.*` is accepted only when it matches the
  target table name (case-insensitive) or `stmt.alias`; otherwise raises
  `Table '<x>' not found in FROM clause for qualified RETURNING *`.
- **UPDATE only:** each expanded projection carries
  `attributeId = newColumnAttributeIds[columnIndex]`, matching the named path's
  NEW-attr coordination.

The view / maintained-table / multi-source paths already supported `*`; no
behavior change there.

## Review findings

Adversarial pass over the implement diff (commit `49614af6`). I read the full
diff with fresh eyes before the handoff summary, then re-derived the claims.

### Checked — and clean

- **Imports / lint:** `QuereusError` / `StatusCode` are still used elsewhere in
  insert/update/delete after the throws were removed (no dangling imports).
  `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`)
  exits 0.
- **UPDATE attributeId alignment:** `newColumnAttributeIds[columnIndex]` is built
  from `newAttributes` indexed by the same `tableSchema.columns` column index the
  helper iterates — alignment holds; the star's NEW-attr coordination matches the
  named path exactly. INSERT/DELETE correctly omit the attribute id (fresh ids
  minted by ReturningNode), consistent with their named paths.
- **Hidden-column parity:** the codebase has no per-column "hidden" flag on base
  tables (the "hidden" concept is about implicit covering *indexes*, not
  columns), so iterating `tableSchema.columns` matches the named-RETURNING symbol
  set and is the correct full user-visible column list. No SELECT-`*`-style hidden
  filtering is owed here.
- **Image binding:** DELETE's unqualified symbols bind OLD (verified in
  `delete.ts:294`), so `delete ... returning *` yields the pre-deletion image;
  INSERT/UPDATE bind NEW. Confirmed by §9 / `old.value, *` composition test.
- **Cascade re-reconciliation in `42-returning.sqllogic`:** line 16 flipping from
  an expected error to a returned row means id=102 is now genuinely inserted; the
  three downstream `SELECT *` checks and the multi-row UPDATE RETURNING were
  re-reconciled to include id=102 with consistent values (200/"second") — a
  correct cascade, not a two-deep masked patch.
- **Aliased-target `t.*`:** ordinary base-table UPDATE/DELETE never set
  `stmt.alias` (only subquery-descent does, and those route to the view path), so
  the alias branch is effectively reachable only via that route — no user-SQL gap.
- **Tests:** targeted run of `42-returning`, `42.1-returning-extras`,
  `93.4-view-mutation`, `53.1-materialized-view-write-through` all pass; full
  memory suite **6259 passing, 9 pending, 0 failing**.

### Found — fixed inline (minor)

- **Coverage gap: multi-row star.** The implementer's §9 cases were all
  single-row; the star-vs-rowcount interaction (one expanded row *per* mutated
  row) was unpinned. Added two assertions to `42.1-returning-extras.sqllogic` §9:
  a multi-row `insert ... values (...),(...) returning *` (two rows) and a
  multi-row `update ... where id in (...) returning *` (NEW image per row). Both
  pass.

### Found — filed as backlog (major-ish, pre-existing)

- **View-path `<wrong>.*` qualifier is unvalidated.** Confirmed the handoff's
  flagged gap: `rewriteViewReturning` (single-source) and
  `buildReturningProjection` (multi-source) expand *all* view columns regardless
  of `rc.table`, so `update <view> ... returning bogus.*` silently expands rather
  than erroring — inconsistent with the now-validating base-table path. This is
  pre-existing (the view path never validated qualifiers) and tightening it needs
  the view name/alias threaded into both functions, so it is **not** a trivial
  inline fix. Filed `tickets/backlog/view-returning-star-qualifier-validation.md`.
  Low user impact (a typo returns columns rather than erroring — no corruption),
  hence backlog rather than fix.

### Considered — no action (with reason)

- **`returning *, *` (duplicate stars):** works (columns set twice, names
  de-dup); SQLite permits it; left unasserted as low-value, per the handoff.
- **Multi-source "no base term" diagnostic for `*`:** the handoff could not
  construct a genuinely unrecoverable mutable-join-view column whose `*` expansion
  fails; I did not pursue it further — the branch reads as defensive and the
  positive multi-source `*` tests (incl. `dr_jv`'s computed `banner`) exercise the
  recomputing path. No regression introduced by this ticket.
- **DRY of the qualifier-not-found error vs `buildStarProjections`:** the two
  operate on different inputs (schema columns vs relation attributes); sharing
  would not be clean. Acceptable duplication.

## Docs

`docs/sql.md` updated: INSERT/UPDATE/DELETE grammar lines now show
`returning { * | table.* | [qualifier.]expr [[as] alias] }`, and §2.5.1 gained
an explicit `* / table.*` expansion rule (in-place, declaration order,
NEW-for-INSERT/UPDATE / OLD-for-DELETE image, qualifier-must-name-target, and the
view-expands-to-view-columns note). Verified against the shipped behavior.

## Validation run (review)

- `yarn workspace @quereus/quereus lint` — exit 0.
- `yarn workspace @quereus/quereus test` (memory suite) — **6259 passing, 9
  pending, 0 failing**.
- `test:store` / `test:full` not run (store-specific, slow; per the ticket).
  RETURNING * routes through the same base-table machinery the store path already
  exercises.
