description: Review test additions for join-residual, prefix-delete, and cross-schema FK parent-side enforcement coverage.
files:
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts   # 5 new test cases added
  - packages/quereus/test/logic/51.85-maintained-table-parent-fk.sqllogic  # new; store backend coverage
difficulty: easy
----

# Review: maintained-parent-fk-residual-arm-coverage

## What was implemented

Added 5 new test cases to `maintained-parent-fk.spec.ts` and a new sqllogic file covering LevelDB store backend.

### Phase 1 — join-residual arm (2 cases)
`describe('join-residual arm (1:1 inner join) as an FK parent', ...)`

Setup: `p (id pk, name text)` + `t (id pk, fk not null references p(id))` + `m (id pk, t_fk, p_name) maintained as select t.id, t.fk as t_fk, p.name as p_name from t join p on t.fk = p.id` + `c (cid pk, m_id, <fk>)`. White-box asserts `registeredPlanKind('main.m') === 'join-residual'`.

- **CASCADE**: delete t(10) → applyForwardResidual → delete-key for m(10) → cascade removes c(100) ✓
- **RESTRICT**: same path → RESTRICT throws, full rollback ✓

### Phase 2 — prefix-delete arm (2 cases)
`describe('prefix-delete arm (lateral TVF fan-out) as an FK parent', ...)`

Setup: `src (id pk, n)` + `m (sid, v, primary key (sid, v)) maintained as select src.id as sid, f.value as v from src cross join lateral generate_series(1, src.n) f` + `c (cid pk, sid, v, foreign key (sid, v) references m(sid, v) on delete ...)`. src(1, n=3) fans out to (1,1),(1,2),(1,3). c(100) references (1,2). White-box asserts `registeredPlanKind('main.m') === 'prefix-delete'`.

- **CASCADE**: delete src(1) → 3 delete-keys → (1,2) cascades c(100) → m and c both reduced ✓
- **RESTRICT**: delete src(1) → (1,2) RESTRICT from c(100) → throws, full rollback ✓

### Phase 3 — cross-schema (1 case)
`describe('cross-schema: maintained table and FK child both in s2, derivation source in main', ...)`

**Design note:** The ticket described a scenario with child in `s2` and parent in `main`. However, the engine's reverse-FK index always keys an FK under `(fk.referencedSchema=childSchema).referencedTable`, so a child in `s2` referencing `m` is keyed under `s2.m`; when enforcement fires for `main.m`, it looks up `main.m` and finds nothing. True cross-schema FK enforcement (child schema ≠ parent schema) is a known engine limitation. The test was redesigned so BOTH maintained table (`s2.m`) AND child (`s2.c`) are in `s2`; the derivation body reads `main.src`. This tests the cross-schema maintenance path while remaining a valid enforcement test.

- `db.schemaManager.addSchema('s2')` before SQL block
- `s2.m maintained as select id from src` (source in main)
- `s2.c` with FK `references m(id) on delete restrict`
- RESTRICT from s2.c blocks delete of src(1) ✓
- Unreferenced src(2) deletes cleanly ✓

### Store backend sqllogic (`51.85-maintained-table-parent-fk.sqllogic`)
Covers inverse-projection arm (arm-agnostic enforcement, any arm is sufficient):
1. RESTRICT + rollback verification
2. CASCADE removes children
3. SET NULL clears child FK column
4. SET DEFAULT resets to default (simple non-nested case)

## Test results

- `yarn test`: 6114 passing, 9 pending — no regressions
- `yarn test:store --grep "51.85"`: 1 passing (store backend sqllogic)

## Known gaps / reviewer focus areas

- The cross-schema test (as originally specified with child in `s2`, parent in `main`) is not implemented because the engine's reverse-FK index lookup would miss it. This is a pre-existing engine limitation, not a regression. The reviewer may want to file a `backlog/` ticket for true cross-schema FK enforcement if that capability is desired.
- The ticket's claim that `getReferencingForeignKeys('main', 'm')` returns the s2.c FK was incorrect; the FK is keyed under `s2.m` (child's schema + referenced table name). The test was redesigned accordingly.
- SET DEFAULT transitive-recursion caveat (nested SET DEFAULT → RESTRICT) is not tested here — that's a pre-existing status-quo gap documented in the ticket and left for a separate ticket.
