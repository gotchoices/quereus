description: Review — `insert defaults` clauses (plain views AND MVs) now rewrite during ALTER TABLE RENAME COLUMN / RENAME TO propagation, and a clause-only rewrite fires view_modified / materialized_view_modified.
files:
  - packages/quereus/src/schema/rename-rewriter.ts              # NEW: collectFromTableNames (moved from differ), renameTableInInsertDefaults, renameColumnInInsertDefaults
  - packages/quereus/src/schema/schema-differ.ts                # collectFromTableNames removed locally, imported from rename-rewriter (behavior-identical)
  - packages/quereus/src/runtime/emit/alter-table.ts            # both plain-view loops: bodyChanged|clauseChanged gating; resolveColumnInSource threaded to MV column propagation
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # both MV propagations: clause rewrite + gating; applyMaterializedViewRewrite overrides widened with insertDefaults, bodyHash/DDL from post-override clause, renamedColumns=bodyChanged
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic       # new sections 18–21
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic  # new sections 7–9
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts       # 2 new view + 2 new MV RENAME event/DDL/bodyHash tests
  - docs/view-updateability.md                                  # § View insert defaults: clause rides rename propagation
  - docs/materialized-views.md                                  # § Rename propagation: clause + clause-only backing-rename skip
  - docs/sql.md                                                 # RENAME TO / RENAME COLUMN dependent-object enumerations
----

# Review: `insert defaults` clause rewrite on source rename propagation

## What was built

All three reproduced failure modes from the fix ticket now pass (verified live and
pinned in tests):

1. **Plain view, `d.column` stale after RENAME COLUMN** (dominant projected-away
   case) — clause target rewrites; insert through the view lands the default in
   the renamed base column.
2. **`d.expr` subquery table ref stale after RENAME TO** — expr subqueries
   rewrite via the table walker; insert succeeds. (Plus the column-rename
   analogue: a rename on a non-FROM table referenced only inside `d.expr`.)
3. **MV clause-only skip** — both plain-view loops and both MV propagations now
   gate on `bodyChanged || clauseChanged`, so a view/MV whose body never
   mentions the renamed name still rewrites, re-hashes, regenerates DDL, and
   fires exactly one `view_modified` / `materialized_view_modified`.

### Design as landed (matches the ticket's design section)

- `schema/rename-rewriter.ts` gains `renameTableInInsertDefaults` (descends into
  each `d.expr`; `d.column` untouched on table rename; exprs mutated in place,
  input array returned as-is) and `renameColumnInInsertDefaults` (`d.column`
  swaps when the renamed table ∈ the view's FROM tables; `d.expr` gets the
  seeded `renameColumnInCheckExpression` walk when renamed table ∈ FROM tables,
  plain `renameColumnInAst` otherwise; returns a fresh array only so `column`
  string swaps don't mutate frozen entries). Both return `null` on an
  empty/undefined clause.
- `collectFromTableNames` **moved** from schema-differ.ts to rename-rewriter.ts
  (exported, doc generalized for both directions); the differ imports it —
  differ behavior untouched.
- `applyMaterializedViewRewrite` overrides widened to include `insertDefaults`;
  `bodyHash` and the regenerated DDL both read the POST-override clause (the
  old code hashed `mv.insertDefaults` verbatim). Column-rename propagation
  passes `renamedColumns: bodyChanged` so a clause-only change never runs
  `renameShiftedBackingColumns`.
- `resolveColumnInSource` (built once in `propagateColumnRename`,
  alter-table.ts) is threaded into `propagateColumnRenameToMaterializedViews`
  as a new parameter — single construction, as the ticket asked.
- Pre-stale MV discipline untouched: the `wasPreStale` gate in
  `applyMaterializedViewRewrite` was not modified; a pre-stale MV still gets
  clause/sql/hash rewritten without re-registration.

## Use cases to validate (all covered by tests; good review entry points)

```sql
-- 41.3 §18: clause-only plain view (projected-away NOT NULL target)
create view v as select id, name from t insert defaults (created = 99);
alter table t rename column created to created_at;
insert into v values (1, 'x');                 -- default lands in created_at
select is_insertable_into from view_info('v'); -- stays YES

-- 41.3 §19/§20: RENAME TO / RENAME COLUMN of a table only referenced
-- inside a d.expr subquery (non-FROM table → plain scope-aware walk)
create view v as select id from t insert defaults (ts = (select max(c) from audit));

-- 41.3 §21: one rename hits body projection AND clause target
create view v as select id, v from t insert defaults (v = 42);
alter table t rename column v to w;
insert into v (id) values (1);                 -- default lands under w

-- 53.2 §7: MV clause-only (the pre-fix `continue` bug)
-- 53.2 §8: MV body+clause combined — backing output name shifts AND clause rewrites
-- 53.2 §9: MV RENAME TO inside d.expr subquery (clause-only, table rename path)
```

Spec tests (view-mv-ddl-persistence.spec.ts) pin the event/persistence contract:
clause-only rename → exactly ONE modified event; regenerated DDL carries the new
name and drops the old; MV `newObject.sql === generateMaterializedViewDDL(newObject)`;
MV `bodyHash === computeBodyHash(viewDefinitionToCanonicalString(columns, selectAst, insertDefaults))`
post-rename (i.e. matches what the differ recomputes); MV stays non-stale.

## Validation performed

- `yarn test` (root): all 12 workspace suites pass — 5590 passing in
  @quereus/quereus, 0 failing.
- Targeted re-runs: logic driver for 41.3 + 53.2 (pass), full
  view-mv-ddl-persistence.spec.ts (50 passing).
- `yarn workspace @quereus/quereus lint`: clean.
- No pre-existing failures encountered (no `.pre-existing-error.md` filed).

## Known gaps / honest notes for the reviewer

- **Differ refactor skipped (per ticket guidance).** The ticket offered an
  optional refactor of `reconciledDeclaredViewDefinition` onto the new helpers
  "ONLY if behavior-identical". The inverse path pre-clones exprs, iterates a
  per-table rename map, and seeds each FROM table with its own-rename lookup —
  it does not map cleanly onto the forward helpers' single-rename signature, so
  it stays hand-rolled. The two implementations encode the same scoping rules
  in two places and could drift; the shared `collectFromTableNames` is the only
  unification.
- **Seeded-walk coverage.** When the renamed table is a FROM table, `d.expr`
  takes the CHECK-seeded walk (differ parity). Because a valid `d.expr` cannot
  reference base columns (it is appended to VALUES rows), no test exists where
  the seeded walk produces a different outcome than the plain walk would — the
  seed is correctness-by-parity, not separately observable today.
- **Table-rename clause override is implicit.** `renameTableInInsertDefaults`
  mutates exprs in place and returns the same array, so the MV table-rename
  path does NOT pass `insertDefaults` in overrides — the rewritten exprs are
  visible through `mv.insertDefaults` when hashing. Consistent with the body's
  in-place handling, but the asymmetry vs the column path (fresh array → real
  override) is worth a look.
- **Cross-schema views (pre-existing scope).** The plain-view/MV loops only run
  for views in the renamed table's home schema (the same-schema gate predates
  this ticket); a view in another schema reading the renamed table gets neither
  body nor clause rewrite. Unchanged behavior, noted for completeness.
- **Plain-view `sql` field (pre-existing).** The view loops set `view.sql` to
  `astToString(view.selectAst)` (body only — no clause, no CREATE wrapper);
  store re-persistence uses `generateViewDDL(newObject)` instead, which is what
  the new tests assert against. Not changed by this ticket.
