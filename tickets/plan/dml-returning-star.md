description: Support `RETURNING *` (and `RETURNING t.*`) on INSERT / UPDATE / DELETE. All three DML builders currently reject the `all` returning-clause form with `'RETURNING * not yet supported'` (UNSUPPORTED). Standard semantics: `*` expands to the target relation's full column list, in declaration order, over the per-row mutation image (NEW for INSERT/UPDATE, OLD for DELETE).
files:
  - packages/quereus/src/planner/building/insert.ts                 # ~812 rc.type === 'all' throw; the RETURNING projection build + OLD/NEW attribute scope
  - packages/quereus/src/planner/building/update.ts                 # ~326 same
  - packages/quereus/src/planner/building/delete.ts                 # ~308 same
  - packages/quereus/src/planner/building/select.ts                 # `*` / `table.*` expansion in the select projection builder — the existing star-expansion to reuse, not re-implement
  - packages/quereus/test/logic/                                    # new RETURNING * coverage (the per-DML returning suites)
  - docs/sql.md                                                     # RETURNING clause — currently silent on `*`
difficulty: medium
----

# `RETURNING *` for INSERT / UPDATE / DELETE

## Current behavior

The RETURNING-clause builder distinguishes a named projection list from the
wildcard form (`rc.type === 'all'`). Named lists are fully supported; the
wildcard is rejected identically in all three DML builders:

```ts
// insert.ts:812 / update.ts:326 / delete.ts:308
// TODO: Support RETURNING *
if (rc.type === 'all') throw new QuereusError('RETURNING * not yet supported', StatusCode.UNSUPPORTED);
```

So `insert into t (…) values (…) returning *` (and the update/delete forms) error
out today, even though every other RETURNING shape works and the per-row mutation
image the projection evaluates over is already built (the OLD/NEW attribute scope
each builder constructs for named RETURNING expressions).

## Expected behavior

- `returning *` expands to **every column of the target relation, in declaration
  order**, evaluated over the statement's per-row mutation image:
  - **INSERT / UPDATE** → the **NEW** (post-mutation) row image.
  - **DELETE** → the **OLD** (pre-deletion) row image.
- `returning t.*` (qualified by the target's name/alias) expands the same way; an
  unknown qualifier is the existing "no such table/alias" diagnostic, not a
  generic failure.
- `returning *, <expr>` / `returning <expr>, *` compose — the star expands in
  place and the surrounding expressions keep their positions (mirror the SELECT
  projection builder's mixed `*`-plus-expression handling).
- The expansion **reuses the existing star-expansion machinery** the SELECT
  projection builder already has (`select.ts`), pointed at the DML target's column
  descriptor / OLD-NEW scope — do not re-implement column enumeration.

## Edge cases & interactions (for the plan pass to enumerate)

- **View / maintained-table targets.** A write through a view or maintained table
  routes to base tables; `returning *` must expand to the **view's / maintained
  table's own** output columns (the logical row the writer sees), not the base
  table columns. Confirm the expansion source is the target relation's published
  shape, and that a computed/derived view column returns its computed value.
- **Decomposition / multi-source view target.** The NEW image of a multi-source or
  decomposition write is assembled across members; `returning *` must reflect the
  reassembled logical row. Pin a case.
- **Generated / default-filled columns.** A column filled by DEFAULT or a generated
  expression must appear in `returning *` with its resolved value (the NEW image
  already carries it).
- **DELETE OLD image.** Confirm the delete builder's OLD attribute scope exposes
  every column for the star (it is built for named RETURNING already).
- **Column ordering & collation.** Declaration order; declared column collations
  carry into the projected attribute types (the write-path collation conformance
  work — reuse `columnSchemaToScalarType`, do not hand-build collation-blind types).
- **Star over a zero-result mutation** (no rows matched) → empty result set, not an
  error.
- **Relational orthogonality.** `RETURNING *` makes the DML a relation usable in
  subquery / CTE position; confirm it composes there (it is just a wider projection).

## Acceptance

- `returning *` and `returning t.*` work for INSERT, UPDATE, DELETE over base
  tables, views, and maintained tables, returning the target's full column set in
  declaration order over the correct (NEW/OLD) image.
- Mixed `returning *, expr` forms expand in place.
- The three `throw 'RETURNING * not yet supported'` sites are removed.
- docs/sql.md RETURNING section documents `*` / `table.*` and the NEW-vs-OLD image
  rule; logic tests cover each DML kind plus the view/maintained-table and
  mixed-projection cases.
