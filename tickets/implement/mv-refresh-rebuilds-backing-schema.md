description: Make `refresh materialized view` rebuild the backing table's *schema* (columns/types/PK/ordering) when a source `alter` has shifted the re-planned body's output shape, instead of only swapping the row data into the stale create-time schema. This repairs a latent direct-read corruption for schema-shifting (`select *`) MV bodies AND restores positional backing↔body alignment, which automatically re-enables the join-subsumption read-rewrite (the original ask of `mv-join-rewrite-schema-evolution`).
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/test/query-rewrite-join.spec.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md, docs/optimizer.md
----

## Problem (root cause — wider than the originating ticket assumed)

`mv-join-rewrite-schema-evolution` asked to re-enable the join-subsumption read-rewrite
for a `select *` join MV after a source `alter table … add column` + `refresh`. The
originating ticket framed this as a *matcher* limitation: the rewrite keys backing columns
by the MV body's output **position** (`mvStoredJoinColumns`), and a source column add makes
the re-planned `select *` body **interleave** the new column while the refreshed backing
does not reorder to match — so the position map reads the wrong column. The review of
`mv-query-rewrite-join-subsumption` added `backingAlignsWithBody` to *forgo* the rewrite on
any positional name mismatch, making the read **correct (base recompute) but unoptimized**.

Empirical investigation during planning found the gap is **deeper than a missed
optimization — refresh leaves the backing materially corrupt for any schema-shifting body**.
`refresh materialized view` (`emitRefreshMaterializedView` → `rebuildBacking`) only re-runs
the body and calls `manager.replaceBaseLayer(rows)` — it **never rebuilds the backing
`TableSchema`**. So after a source column add:

```sql
create table customers (id integer primary key, name text not null);
create table orders   (id integer primary key,
                       customer_id integer not null references customers(id),
                       amt integer not null);
create materialized view v as
  select * from orders o join customers c on o.customer_id = c.id;
-- backing _mv_v columns: [id, customer_id, amt, id:1, name]   (5 cols)

alter table orders add column extra text default 'x';   -- marks v stale
refresh materialized view v;
-- backing _mv_v columns: STILL [id, customer_id, amt, id:1, name]   (NOT rebuilt)
-- but the re-planned body now produces 6-col rows:
--   [o.id, o.customer_id, o.amt, o.extra, c.id, c.name]
-- replaceBaseLayer stuffs the 6-element rows into the 5-col backing.

select * from v;
-- CORRUPTED: {id:10, customer_id:1, amt:100, "id:1":"x", name:1, col_5:"alice"}
--   value of o.extra ('x') surfaces under label "id:1"
--   value of c.id   (1)   surfaces under label "name"
--   value of c.name ('alice') surfaces under a fabricated "col_5"
```

So the **direct read** `select * from v` is silently wrong after `alter`+`refresh`, entirely
independent of the read-rewrite. This means the matcher-only candidate from the originating
ticket (a provenance/name-keyed body→backing map) is **unsound on its own**: the backing
*data* is shifted relative to its column labels, so no remapping can recover correct values
from it. The backing must first be rebuilt to match the current body. Once it is, the
existing position-keyed map is correct again and `backingAlignsWithBody` passes, so the join
rewrite re-enables with **no matcher change required**.

Single-source `select *` MVs and explicit-column MVs happened to dodge this: a single-source
column add **appends** to the body output (stays positionally aligned with the appended
backing intent — though see edge cases, the backing schema still isn't widened), and an
explicit-column body's output set is stable. The join `select *` shape is where the
interleave bites, but the fix below is shape-agnostic.

## Fix: refresh re-derives the backing shape and rebuilds the backing table when it shifted

Refresh becomes shape-aware. After body re-validation and before re-registering row-time
maintenance, re-derive the canonical backing shape from the (re-planned) body and compare it
to the live backing `TableSchema`:

```
emitRefreshMaterializedView:
  if mv.stale: revalidateBody(...)                       # unchanged
  shape   = deriveBackingShape(db, bodySql, mv.columns)  # re-plan, derive columns/PK/ordering
  current = sm.getTable(mv.schemaName, mv.backingTableName)
  if backingShapeMatches(current, shape):
      await rebuildBacking(db, mv)                        # FAST PATH (today): replaceBaseLayer only,
                                                          #   backing identity preserved, caches warm
  else:
      await rebuildBackingTable(db, mv, shape)           # NEW: drop+recreate backing, then fill
      mv.primaryKey  = shape.primaryKey                  # keep MV record consistent with new shape
      mv.ordering    = shape.ordering
      mv.sourceTables = shape.sourceTables               # (unchanged by a column add, set for parity)
  db.registerMaterializedView(mv)                         # binds row-time plan to the (new) backing
  mv.stale = false
  notify materialized_view_refreshed
```

`rebuildBackingTable` mirrors the create path (`emitCreateMaterializedView`) exactly,
reusing the existing helpers so there is one code path for "make the backing match the body":

```
async function rebuildBackingTable(db, mv, shape):
  await sm.dropTable(mv.schemaName, mv.backingTableName, /*ifExists*/ true)  # fires table_removed → invalidates cached plans reading the backing
  const backingSchema = buildBackingTableSchema(db, mv.schemaName, mv.backingTableName, shape)
  const complete = await sm.createBackingTable(backingSchema)               # fires table_added
  const rows = await collectBodyRows(db, astToString(mv.selectAst))
  const mgr  = getBackingManager(complete)
  await mgr.replaceBaseLayer(rows, () => materializedViewNotASetError(mv.schemaName, mv.name))
```

Put `rebuildBackingTable` and `backingShapeMatches` in
`runtime/emit/materialized-view-helpers.ts` next to `rebuildBacking`/`deriveBackingShape`.

**Why conditional (only rebuild when the shape shifted), not always:** an unconditional
drop+recreate on every refresh would change the backing `TableSchema` identity each time,
invalidating every cached `select … from <mv>` prepared plan and the `MV_BODY_ROOT_CACHE`
on *every* refresh — a real regression for the common periodic-refresh-of-a-stale-snapshot
case where the shape is unchanged. The fast path keeps today's cost and identity for that
case; the rebuild fires only when the columns/types/PK/ordering actually changed.

**`backingShapeMatches(current: TableSchema, shape: BackingShape)`** returns true iff the
derived shape would produce a structurally identical backing — compare, in order:
- column **count**;
- per column: **name** (case-insensitive — matches the matcher's name compare), **logical
  type**, **notNull**, **collation**;
- the **physical** PK: `computeBackingPrimaryKey(shape)` vs `current.primaryKeyDefinition`
  (index + desc + collation, in order).

`computeBackingPrimaryKey` is currently a private fn in `materialized-view-helpers.ts`;
export it (or compute the comparison inside that module) so the compare uses the *physical*
PK the rebuild would actually install, not the logical `shape.primaryKey`.

## Why this re-enables the join rewrite with no matcher change

Once refresh rebuilds the backing to match the current body output, the backing columns are
positionally aligned with the body again, so:
- `backingAlignsWithBody` (the soundness guard the review added) **passes** → the join arm
  no longer forgoes;
- `mvStoredJoinColumns`' position-keyed map is correct again;
- `plannedMvBodyRoot`/`cachedBodyRootIsCurrent` already re-derive the cached body root after
  a source `alter` (source `TableSchema` identity changed), so the cache serves the
  post-alter body root against the post-refresh backing.

**Keep `backingAlignsWithBody` as defense-in-depth** (the originating ticket's out-of-scope
constraint: "the soundness guard must remain"). It now passes in the happy path but still
forgoes if any future path desynchronizes the backing — the matcher never trusts position
blindly. Do **not** implement the provenance/name-keyed map from the originating ticket's
candidate list: it is unnecessary once the backing is rebuilt, and would be unsound without
the rebuild anyway. (If a future ticket wants to harden the foundation/aggregate arms with a
provenance map as belt-and-suspenders, file it separately — it is not needed here.)

## Edge cases & interactions

- **Explicit-column MV whose body output count shifts.** `create materialized view v(a,b,c)
  as <body>` then a source alter changes the body to 4 outputs. `deriveBackingShape` pads
  missing names with `col${i}`, silently widening a user-declared column list. Decide and
  test: **error** at refresh with a clear diagnostic ("materialized view 'v' was declared
  with N columns but its body now produces M after a source change — drop and recreate")
  rather than silently reshaping a declared interface. (A source column *add* under an
  explicit-column list is the realistic trigger.) Match the diagnostic style of
  `revalidateBody`.
- **Fast-path identity/caches preserved.** A refresh with **no** shape change must keep the
  backing `TableSchema` identity (assert in a test: `getTable(...)` returns the *same*
  object before/after) so cached plans and `MV_BODY_ROOT_CACHE` stay warm — i.e. the
  conditional actually takes the fast path for an unchanged body.
- **Rebuild path within the refresh transaction.** `refresh` runs inside
  `_ensureTransaction()`. `dropTable` + `createBackingTable` mid-transaction must leave the
  backing usable for the immediately-following `collectBodyRows`/`replaceBaseLayer` and for
  reads later in the same transaction (reads-own-writes). The create path already does
  drop-on-rollback within a txn; verify the drop+recreate+fill sequence commits cleanly and
  that an open connection to the *old* backing (if any) does not serve stale rows. If
  transactional drop+recreate proves fragile, the fallback is an in-place schema rebuild
  mirroring `alter-table.ts` `rebuildMemoryTable` (swap module+catalog, preserve name, fire
  `table_modified`) — but prefer drop+recreate for code reuse with create.
- **Cached prepared `select … from <mv>` plans.** The rebuild's `table_removed`/`table_added`
  (or `table_modified` if using the in-place fallback) on `_mv_<name>` must invalidate any
  cached plan that scans the backing directly, so the next read recompiles against the new
  column set. Verify `select * from v` returns the **new** column shape after refresh (the
  corruption case above must now be correct). Cross-check against
  `materialized-view-stale-cached-plan-invalidation` (complete) and `emitBackingInvalidation`
  — confirm the existing invalidation machinery covers the refresh-rebuild path; add an
  explicit invalidation emit if it does not.
- **MV-over-MV cascade.** When the rebuilt backing is itself a source of a consumer MV, the
  `table_removed`/`table_added` on the producer backing marks the consumer stale (the
  manager's `subscribeToSchemaChanges` listener treats the backing as a source for the
  consumer). That is correct — the consumer needs its own refresh — but assert the cascade
  terminates (the DAG is acyclic) and does not throw mid-refresh. A producer refresh that
  reshapes its backing should not leave a consumer half-maintained.
- **Row-time maintenance binds to the new backing.** `registerMaterializedView` runs the
  eligibility gate + builds the maintenance plan against the backing; it must run **after**
  the rebuild so the plan's `backingPkDefinition`/projectors reflect the new shape. Keep the
  existing order (rebuild → register → clear stale). A post-refresh source row-write must
  maintain the new backing correctly (test: insert a source row after the reshape, read the
  MV, confirm the new column propagates).
- **PK shift on reshape.** A column add usually preserves the PK, but if `keysOf` over the
  re-planned body picks a different key (or the all-columns fallback widens), the new backing
  PK differs. `replaceBaseLayer` extracts keys via the *new* backing schema's PK functions,
  so this is consistent by construction — but add a test where the reshape changes the
  derived PK and confirm no duplicate-key false positive and correct dedup.
- **`materializedViewNotASetError` on reshape.** If the reshaped body becomes
  duplicate-producing under the new PK, the fill's `replaceBaseLayer` raises the "must be a
  set" diagnostic and the refresh fails — leaving the MV stale (so the next read
  re-validates/errors rather than serving a half-built backing). Verify the failure path
  leaves a coherent state (old backing already dropped → MV stale, not silently empty).
- **Incompatible alter (column the body depends on is dropped/retyped).** Already handled by
  `revalidateBody` (throws the staleness diagnostic before we reach the reshape). Confirm the
  reshape code is only reached for bodies that re-plan successfully.
- **Non-`select *` schema-shift.** The fix is shape-driven, not `select *`-specific. A body
  `select o.*, c.name …` that gains an `orders` column also shifts; the same rebuild applies.
  Add at least one non-`*` interleave test.

## Key tests (TDD targets)

- **Direct-read correctness (the corruption regression).** `select *` join MV, `alter table
  <driving> add column … default …`, `refresh`, then `select * from v` returns the correct
  6-column shape with values under the right labels (the planning-probe case above must now
  be correct). This is the primary regression and currently **fails** (returns shifted
  values) — write it first.
- **Join rewrite re-enabled.** After the same `alter`+`refresh`, a join query over the two
  base tables (`select o.id, c.name from orders o join customers c on …`) is rewritten to a
  `_mv_v` backing scan (assert via `serializePlanTree`/golden plan that the join is
  eliminated) AND returns correct rows. Pair with the existing forgo test in
  `query-rewrite-join.spec.ts` (which asserts pre-fix correctness) — that test should now
  show the rewrite firing; update its expectation.
- **Fast-path identity preserved.** Refresh with no source change → backing `TableSchema`
  identity unchanged (same object), `select * from v` shape unchanged. Guards against the
  unconditional-rebuild regression.
- **Explicit-column count-shift → clear error** (see edge cases).
- **Row-time after reshape.** Post-reshape source insert propagates the new column into the
  backing and is visible via `select * from v`.
- **sqllogic coverage** in `51-materialized-views.sqllogic`: add an `alter`+`refresh`+`select
  *` sequence asserting the post-refresh column values (sqllogic is the primary suite per
  AGENTS.md).

## Validation

- `yarn test` (memory vtab) green; the new direct-read regression passes.
- `yarn lint` clean on changed files (single-quote globs on Windows per AGENTS.md).
- Spot-run `yarn test:store` for the `alter`/`refresh` paths if time permits (ALTER exercises
  the store code path) — but it is slower; document if deferred.
- Update `docs/materialized-views.md` § refresh to state that refresh re-derives and rebuilds
  the backing schema when the body shape shifts; update `docs/optimizer.md` §
  *Materialized-view query rewrite (read side)* to note the join rewrite re-enables after a
  schema-shifting refresh (alignment restored by the rebuild) and that
  `backingAlignsWithBody` remains as defense-in-depth.

## TODO

- Add `backingShapeMatches(current, shape)` + `rebuildBackingTable(db, mv, shape)` to
  `materialized-view-helpers.ts`; export `computeBackingPrimaryKey` (or do the PK compare in
  that module).
- Wire the conditional rebuild into `emitRefreshMaterializedView`
  (`runtime/emit/materialized-view.ts`): re-derive shape, compare, fast-path vs rebuild,
  update `mv.primaryKey`/`ordering`/`sourceTables` on rebuild, keep rebuild→register→clear
  order.
- Add the explicit-column count-shift error path + diagnostic.
- Confirm cached-plan invalidation covers the refresh-rebuild (verify
  `table_removed`/`table_added` or add an emit); confirm MV-over-MV cascade terminates.
- Write the tests above (direct-read regression first; rewrite-re-enabled; fast-path
  identity; explicit-column error; row-time-after-reshape; sqllogic sequence).
- Keep `backingAlignsWithBody` and `cachedBodyRootIsCurrent` unchanged (defense-in-depth);
  do NOT add the provenance map.
- Update `docs/materialized-views.md` and `docs/optimizer.md`.
