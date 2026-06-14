description: Support `RETURNING *` / `RETURNING t.*` on base-table INSERT / UPDATE / DELETE by expanding the star, in place, into the existing OLD/NEW returning scope. The view / maintained-table / subquery / CTE paths already support it; this ticket closes the base-table gap (the three `'RETURNING * not yet supported'` throws) and adds coverage + docs across all target kinds.
files:
  - packages/quereus/src/planner/building/insert.ts                 # ~777-836 base-table RETURNING build; throw at ~813
  - packages/quereus/src/planner/building/update.ts                 # ~289-347 base-table RETURNING build; throw at ~327
  - packages/quereus/src/planner/building/delete.ts                 # ~272-329 base-table RETURNING build; throw at ~309
  - packages/quereus/src/planner/mutation/single-source.ts          # ~1310 rewriteViewReturning star branch (ALREADY supports *; reference only)
  - packages/quereus/src/planner/mutation/multi-source.ts           # ~2180 buildReturningProjection star branch (ALREADY supports *; reference only)
  - packages/quereus/src/planner/building/select-projections.ts     # buildStarProjections — the SELECT star machinery (qualified-* error shape to mirror)
  - packages/quereus/test/logic/42-returning.sqllogic               # line 16-17 currently asserts the * error + line 23 verify; both must change
  - packages/quereus/test/logic/42.1-returning-extras.sqllogic      # additional base-table RETURNING * cases (mixed projection, t.*, zero-row, subquery position)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # view / multi-source RETURNING * coverage
  - packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic  # maintained-table RETURNING * coverage
  - docs/sql.md                                                     # ~535/558 (insert), ~732/742 (update), delete grammar — add `*` / `table.*` + NEW-vs-OLD rule
difficulty: medium
----

# `RETURNING *` for base-table INSERT / UPDATE / DELETE

## Where the work actually is

`RETURNING *` and `RETURNING <view>.*` are **already fully supported** for every
target that routes through the view-mutation substrate:

- **Single-source view / CTE / subquery target** — `rewriteViewReturning`
  (`single-source.ts:1310`) expands `rc.type === 'all'` to every view output
  column, projected through its base-term lineage, named by the view column.
- **Multi-source (join) view target** — `buildReturningProjection`
  (`multi-source.ts:~2180`) expands `*` to every view output column's base term,
  raising `returning-through-view` if a view column has no base term.
- **Maintained tables** route to `buildViewMutation` via
  `maintainedTableViewLike(...)` in all three builders (`insert.ts:510-511`,
  `update.ts:116-117`, `delete.ts:116-117`), **before** the base-table RETURNING
  code runs — so they inherit the view-path star expansion for free.

The base-table builders are the only sites still rejecting the wildcard:

```ts
// insert.ts:813 / update.ts:327 / delete.ts:309
if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
```

So the implementation is contained to the base-table RETURNING build in three
files. The view/maintained work is *already done* — this ticket must still
**prove it with tests**, because the current suite only exercises named
RETURNING columns through views.

## Design — base-table star expansion

Each base-table builder already constructs a `returningScope`
(`RegisteredScope`) that registers, per target column:

- `old.<col>` → OLD attribute,
- `new.<col>` → NEW attribute,
- `<col>` (unqualified) and `<table>.<col>` (table-qualified) → the
  **statement's default image**: NEW for INSERT/UPDATE, **OLD for DELETE**
  (delete.ts:295-303 binds the unqualified/qualified forms to the OLD attr).

It then maps `stmt.returning` to projections by calling
`buildExpression({ ...ctx, scope: returningScope }, rc.expr)`.

**Reuse the existing scope rather than re-enumerating columns.** Replace the
`.map(rc => …)` with a loop that, for `rc.type === 'all'`, synthesizes one
unqualified column AST ref **per target column in declaration order** and runs
each through the *same* `buildExpression`-over-`returningScope` path the named
columns use:

```ts
// per target column, declaration order:
const colExpr: AST.ColumnExpr = { type: 'column', name: tableColumn.name };
projections.push({
  node: buildExpression({ ...ctx, scope: returningScope }, colExpr) as ScalarPlanNode,
  alias: tableColumn.name,
  // UPDATE only — match the named path's NEW-attr coordination:
  // attributeId: newColumnAttributeIds[columnIndex],
});
```

Resolving through the unqualified registered symbol means the star
**automatically inherits the correct NEW/OLD image and the column's declared
type/collation** — INSERT/UPDATE bind NEW, DELETE binds OLD — with **zero
hand-built types**. (This is the ticket's "reuse the existing star-expansion
machinery" requirement: the machinery being reused is the per-column symbol
resolution the named path already drives, not `buildStarProjections`, which
operates over a `RelationalPlanNode`'s attributes and is the SELECT analog. Do
NOT call `buildStarProjections` here — the DML returning scope is symbol-based,
not attribute-based.)

### Mixed `*` + expression composition

Convert the `stmt.returning.map(...)` into an accumulating loop (or `flatMap`)
so `*` expands **in place** and surrounding expressions keep their positions —
`returning *, upper(name)` and `returning id, *` both work, mirroring the SELECT
projection builder's mixed handling.

### Qualified `t.*`

For `rc.type === 'all'` with `rc.table` set:

- Accept the qualifier when it matches the target table's name
  (`tableReference.tableSchema.name`, case-insensitive). Ordinary base-table
  UPDATE/DELETE never set `stmt.alias` (it is reserved for inline-subquery
  targets, which route to the view path — see update.ts:165-167), so the table
  name is the only valid base-table qualifier; if `stmt.alias` is nonetheless
  present, accept it too.
- Otherwise raise the standard "no such table/alias" diagnostic, mirroring
  `buildStarProjections`' qualified-`*` error
  (`Table '<x>' not found …`, `StatusCode.ERROR`). Do **not** let it fall
  through to a generic failure.

Output column names are the **bare** column names regardless of qualifier
(SELECT `t.*` parity; `alias: tableColumn.name`).

### Remove the three throws

Delete the `'RETURNING * not yet supported'` lines in insert.ts / update.ts /
delete.ts. The `validateReturningQualifiers(rc.expr, …)` guard only applies to
named expressions (OLD-in-INSERT / NEW-in-DELETE) — `*` carries no OLD/NEW
qualifier, so skip the validator for the `all` branch (it takes
`rc.expr`, which the `all` form does not have).

## Edge cases & interactions

- **DELETE binds OLD for `*`.** The unqualified symbol in delete.ts resolves to
  the OLD attribute (delete.ts:295-303), so expanding `*` through it yields the
  pre-deletion image — exactly the required DELETE semantics. Confirm with a
  test that `delete … returning *` returns the deleted row's values.
- **Generated / DEFAULT-filled columns.** The NEW image already carries
  resolved DEFAULT and generated-column values (the named path returns them);
  `*` must surface them. Test: a table with `value INTEGER DEFAULT 100` and/or a
  generated column — `insert … returning *` shows the resolved values.
- **Collation / declared type.** Because `*` resolves through the same registered
  symbol as a named column, the projected attribute type is identical to the
  named path's (update.ts uses `columnSchemaToScalarType`; insert/delete use the
  OLD/NEW `attr.type`). No new type construction — assert a `*` column and the
  same column named explicitly produce identical results, including over a
  collated column (reuse a `06.4.3-write-path-collation`-style column).
- **Zero-row mutation.** `update … where <false> returning *` /
  `delete … where <false> returning *` → empty result set, **not** an error
  (the ReturningNode produces no rows). Pin a case.
- **Relational orthogonality.** `RETURNING *` makes the DML a relation usable in
  subquery / CTE position — it is just a wider projection. Test a
  `select count(*) from (insert … returning *)` or
  `with t as (delete … returning *) select … from t` form (see
  `01.9-query-expr-dml.sqllogic` for the existing DML-as-relation patterns).
- **View / maintained-table target (already-working path — must test).**
  `returning *` through a view / MV / maintained table expands to the **view's /
  maintained table's own output columns**, in the view's declared order, NOT the
  base columns. A computed/derived view column returns its computed value.
- **Multi-source (join) view target.** `returning *` over a 2-table join view
  reflects the reassembled logical row (UPDATE re-queries post-mutation by
  captured identity; DELETE re-queries the OLD image pre-mutation). A
  view column with no base term raises `returning-through-view` — pin that the
  diagnostic, not a generic crash, surfaces.
- **Qualified `<view>.*` over a view is currently NOT qualifier-validated.** The
  view-path `all` branches (`single-source.ts:1310`, `multi-source.ts:~2180`)
  expand all view columns regardless of `rc.table` — so `returning bogus.*`
  through a view silently expands rather than erroring. This is a pre-existing
  over-permissiveness. **Decision: leave it as-is for views in this ticket**
  (tightening it requires threading the view name/alias into both functions and
  is out of scope for a base-table-focused change); the base-table path *does*
  validate the qualifier. Add a one-line TODO comment at each view-path `all`
  branch noting the gap, and a backlog ticket only if the reviewer deems it
  worth a follow-up.
- **`returning *, *` (duplicate stars).** Produces the column set twice; no
  special handling needed (SQLite permits it). Not required to test.

## Test plan (key cases & expected outputs)

**`42-returning.sqllogic` — fix the now-stale assertions first:**
- Line 16-17: `INSERT … (102,'second',200) RETURNING *` currently asserts
  `-- error: RETURNING * not yet supported`. Change to expect
  `→ [{"id":102,"name":"second","value":200}]`.
- Line 23 verify (`SELECT * … ORDER BY id`): id 102 is now actually inserted —
  update the expected set to include `{"id":102,"name":"second","value":200}`
  (and any downstream verify rows that assumed 102 was absent). **Re-run the
  whole file** and reconcile every cascading expectation, don't just patch the
  two lines.

**New base-table cases (in `42-returning.sqllogic` / `42.1-returning-extras.sqllogic`):**
- `insert … values(…) returning *` → full row, declaration order.
- `insert … returning t.*` (qualified by table name) → same as `*`.
- `insert … returning bogus.*` → `-- error:` "not found"/"no such table".
- `update … set … where id=… returning *` → NEW image full row.
- `update … returning *, name` and `update … returning id, *` → in-place expand.
- `update … returning old.value, *` → OLD-qualified expr composes with `*`.
- `delete … where id=… returning *` → OLD (deleted) image full row.
- `update … where 1=0 returning *` / `delete … where 1=0 returning *` → `→ []`.
- DEFAULT/generated column surfaced by `*` (DEFAULT 100 already present).
- Orthogonality: `select count(*) from (insert … returning *)` (or a CTE form).

**View / maintained-table cases (`93.4-view-mutation.sqllogic`,
`53.1-materialized-view-write-through.sqllogic`):**
- Single-source updatable view: `update v set … returning *` → view's columns,
  view order; include a computed view column to confirm it recomputes.
- Multi-source join view: `update v … returning *` and `delete from v …
  returning *` → reassembled logical row.
- Maintained table: `insert into mt … returning *` → maintained table's own
  output columns.

## Validation

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
  (memory-backed; the default agent suite).
- `yarn lint` (single-quote globs on Windows) — catches signature drift if the
  projection loop refactor changes any shared shape.
- Do **not** run `yarn test:store` / `yarn test:full` inside the ticket (slow /
  store-specific); leave for CI.

## TODO

- insert.ts: replace the `all` throw with in-place star expansion over
  `returningScope` (unqualified column refs, declaration order); convert the
  `.map` to an accumulating loop; validate `rc.table` against the table name.
- update.ts: same, additionally setting each expanded projection's `attributeId`
  to `newColumnAttributeIds[columnIndex]` (match the named path's NEW-attr
  coordination).
- delete.ts: same; confirm the unqualified symbol binds OLD (it does) so `*`
  yields the deleted image.
- Skip `validateReturningQualifiers` for the `all` branch (no `rc.expr`).
- Add the view-path TODO comments noting the unvalidated `<view>.*` qualifier.
- Update `42-returning.sqllogic` lines 16-17 + 23 (and cascading verifies);
  re-run and reconcile.
- Add the base-table and view/maintained `RETURNING *` cases above.
- docs/sql.md: extend the INSERT/UPDATE/DELETE `returning` grammar
  (`returning *` | `returning <table>.*` | `[qualifier.]expr …`) and document
  the NEW (INSERT/UPDATE) vs OLD (DELETE) image rule for `*`.
- Run the memory test suite + lint; reconcile failures that are yours.
