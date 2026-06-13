description: Extend maintained-parent-fk.spec.ts with join-residual, prefix-delete, and cross-schema FK cases; add a sqllogic file for LevelDB store backend coverage.
files:
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # extend with 5 new cases
  - packages/quereus/test/logic/51.85-maintained-table-parent-fk.sqllogic  # new; store backend coverage
  - packages/quereus/src/core/database-materialized-views.ts      # reference only (no changes)
  - packages/quereus/src/runtime/foreign-key-actions.ts           # reference only (no changes)
difficulty: easy
----

# Parent-side FK enforcement — remaining arm / backend test coverage

No source changes. This ticket adds tests only.

## Context

`enforceParentSideReferentialActions` is arm-agnostic; it operates on the
`BackingRowChange[]` returned by any apply arm. The existing spec file proves it
on `inverse-projection` and `residual-recompute`. This ticket closes the remaining
coverage gaps:

- `join-residual` arm (applyForwardResidual / applyJoinResidual forward path)
- `prefix-delete` arm (applyPrefixDelete — fan-out slice; composite FK parent)
- cross-schema FK (child in `s2`, parent `M` in `main`)
- LevelDB store backend (`yarn test:store`) — via a new sqllogic file

## Architecture decisions resolved

### join-residual setup
Mirror `test/incremental/maintenance-equivalence.spec.ts` 1:1 join pattern exactly:
- `p (id pk, name text)` + `t (id pk, fk not null references p(id))`
- body: `select t.id, t.fk as t_fk, p.name as p_name from t join p on t.fk = p.id`
- backing PK = `t.id` (proven by `'join-residual'` plan kind assertion)
- child `c (cid pk, m_id integer, fk...)` references `m(id)`
- Deleting a `t` row runs `applyForwardResidual` → recomputes empty → `delete-key` for M row → enforcement

### prefix-delete setup
- `src (id pk, n integer)` + body: `select src.id as sid, f.value as v from src cross join lateral generate_series(1, src.n) f`
- declared backing PK: `(sid, v)` — the natural composite product key the arm produces
- child `c (cid pk, sid integer, v integer, foreign key (sid, v) references m(sid, v) on delete …)`
- Deleting `src(1)` (n=3) → empties the fan-out → `applyPrefixDelete` produces `delete-key`s for (1,1),(1,2),(1,3) → enforcement fires per delete-key
- NOTE: enforcement iterates all backing changes; RESTRICT on `(1,2)` (the referenced row) aborts; CASCADE on `(1,2)` removes child row

### cross-schema FK
- Use `db.schemaManager.addSchema('s2')` (memory backend supports this — proven by `test/schema/reverse-fk-index.spec.ts`)
- `create table s2.c (...) foreign key (m_id) references main.m(id) on delete restrict`
- The reverse FK index keys on `fk.referencedSchema ?? childTable.schemaName` + table → `getReferencingForeignKeys('main', 'm')` returns the s2.c FK ✓
- RESTRICT error message uses only `childTable.name` (= `'c'`), NOT schema-qualified

### store backend sqllogic
- File: `packages/quereus/test/logic/51.85-maintained-table-parent-fk.sqllogic`
- Covers RESTRICT / CASCADE / SET NULL / SET DEFAULT on the inverse-projection arm
- The arm-agnostic hook means any arm is sufficient for backend coverage
- SET DEFAULT in the SIMPLE case (child points to the surviving default-value row) works correctly on both backends; the documented transitive-recursion caveat only applies to a NESTED SET DEFAULT → RESTRICT chain (not tested here — that gap predates this ticket and is status quo on both backends, not a regression)
- `pragma foreign_keys = true` at the top of the file (confirmed used in other sqllogic files)

## Edge cases & interactions

- `join-residual` driving side: only T-side writes exercise `applyForwardResidual`; P-side writes use `applyLookupResidual` (upsert-only — no deletes, no parent-side enforcement). Test only the T-side delete path.
- `prefix-delete` RESTRICT fires on the first backing delete-key that hits a child reference, rolling back all previous deletes in that statement atomically. All three backing rows for src.id=1 (fan-out of 3) must be produced even though only one is referenced.
- Cross-schema create order: `m` is created BEFORE `s2.c` (parent must exist first). The `db.schemaManager.addSchema('s2')` call must precede the `create table s2.c` SQL.
- Store backend: SET DEFAULT test needs both src(1) and src(99) present so the default value (99) survives the delete-of-1 and the FK check on the SET DEFAULT outcome passes (the FK from c to m is still satisfied after setting m_id=99).
- `registeredPlanKind` assertion for join-residual: `rowTime.get('main.m')` where `main.m` is the MV key — confirm lowercase matches the helper signature in the existing spec file.

## TODO

- Extend `test/runtime/maintained-parent-fk.spec.ts`:

  Phase 1 — join-residual arm (two cases)
  - Add `describe('join-residual arm (1:1 inner join) as an FK parent', ...)` block
  - `seedJoin(childFk)` helper creates p, t, m (maintained join), c, inserts seed data, asserts `registeredPlanKind(db, 'main.m') === 'join-residual'`
  - Case 1: CASCADE removes child when T-side delete drops the backing row
  - Case 2: RESTRICT blocks the T-side delete, rolls back source write + cascades

  Phase 2 — prefix-delete arm (two cases)
  - Add `describe('prefix-delete arm (lateral TVF fan-out) as an FK parent', ...)` block
  - `seedFanOut(childFk)` helper creates src, m (maintained lateral), c, inserts seed data, asserts `registeredPlanKind(db, 'main.m') === 'prefix-delete'`
  - Case 1: CASCADE removes child when source delete empties the fan-out slice
  - Case 2: RESTRICT blocks source delete when fan-out backing row is referenced

  Phase 3 — cross-schema FK (one case)
  - Add `describe('cross-schema FK (child in s2 referencing M in main)', ...)` block
  - `db.schemaManager.addSchema('s2')` before the SQL block
  - Case 1: RESTRICT from s2.c blocks the maintenance delete; unreferenced row still maintains cleanly

- Create `packages/quereus/test/logic/51.85-maintained-table-parent-fk.sqllogic`:
  - `pragma foreign_keys = true`
  - Section 1: RESTRICT blocks maintenance delete + rollback verification
  - Section 2: CASCADE removes children
  - Section 3: SET NULL clears child FK column
  - Section 4: SET DEFAULT resets child FK column to default (simple non-nested case)
  - Use `drop table` between sections to reset state (each section independent)

- Run `yarn test` from repo root to confirm all spec tests pass (memory backend)
- Run `yarn test:store` to confirm the new sqllogic file passes (LevelDB backend)
