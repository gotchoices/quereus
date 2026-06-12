----
description: On a body-irrelevant (constraint/stats/tags-only) `table_modified`, recompile dependent MVs' row-time plans in place instead of marking them stale — gated by shape re-derivation, falling back to today's mark-stale on any failure.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # subscribeToSchemaChanges, emitBackingInvalidation
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # new comparator + recompile helper; reuses deriveBackingShape, describeBackingShapeMismatch, sameSourceTables, backing*Matches predicates
  - packages/quereus/src/runtime/emit/alter-table.ts            # event sources only (no change expected): runDropConstraint, runRenameConstraint, rewriteTableForTableRename/ColumnRename
  - packages/quereus/src/runtime/emit/add-constraint.ts         # event source only
  - packages/quereus/src/runtime/emit/analyze.ts                # event source only (statistics-only table_modified)
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic  # idiom reference
  - docs/materialized-views.md
difficulty: hard
----

# Recompile (not stale) dependent MVs on body-irrelevant `table_modified`

`subscribeToSchemaChanges` in `database-materialized-views.ts` treats every
`table_modified` on a source table as body-invalidating: mark each dependent MV
stale, release its compiled row-time plan, invalidate cached backing reads. But a
`table_modified` whose old/new `TableSchema` differ only in fields a body cannot
read — constraint metadata (CHECK exprs, FK targets, UNIQUE sets, index
predicates), `statistics`/`estimatedRows` (ANALYZE), `tags`, column defaults —
cannot change what the body *evaluates to*. Today these events needlessly
de-liven MVs from: `DROP CONSTRAINT` / `RENAME CONSTRAINT` / `ADD CONSTRAINT`,
declarative migrations that only retarget FKs, rename propagation's
constraint-AST rewrites on *other* tables (currently rescued only statement-
locally by `restoreUnaffectedMaterializedViews`), and — a bonus catch —
**ANALYZE**, whose statistics-only `table_modified` (`analyze.ts`) silently
stales every dependent MV today.

## Settled design

**Recompile, never skip.** Constraint metadata can't change body *results*, but
it feeds the **compiled** row-time plan and the optimizer's folds:

- `proveOneToOneJoin` (join-residual arm) rests on NOT-NULL FK→PK referential
  integrity — with the FK dropped, a now-possible `delete from P` of a
  referenced row leaves phantom backing rows (the lookup side of a no-WHERE
  body is upsert-only).
- CHECK constraints seed domain facts (`ruleFilterContradiction`); a compiled
  body/residual scheduler may have folded a filter away — or collapsed the whole
  body to an `EmptyRelation` — against a CHECK that no longer holds.

So on a qualifying event each live dependent MV is **re-registered**
(`registerMaterializedView` → `buildMaintenancePlan` re-runs arm selection /
eligibility / cost gating against the new catalog) rather than marked stale.
Distinguishing "pure semantics-preserving rewrite, could skip recompile" (rename
propagation) from "genuine retarget/drop" would need semantic AST comparison at
the listener for no real win — recompile is DDL-time-only and uniformly sound.
One code path, no classification finer than the column/PK comparator below.

**Shape-rederivation gate (settles the dropped-UNIQUE question).** Before
re-registering, re-derive the backing shape from the body against the
post-change catalog and require it to still match the live backing — exactly the
discipline `restoreUnaffectedMaterializedViews` already uses:

1. `shape = deriveBackingShape(db, astToString(d.selectAst), d.columns)` —
   throws when the body no longer plans → fall back to stale.
2. `sameSourceTables(d.sourceTables, shape.sourceTables)` — an FK drop can
   un-eliminate a previously FK/PK-eliminated join, growing the re-planned
   source set past the recorded one; the record is then out of sync → stale
   (REFRESH re-derives).
3. `describeBackingShapeMismatch(backing, shape) === null` — strict positional
   columns + **exact physical-PK equality** (`computeBackingPrimaryKey(shape)`
   vs `backing.primaryKeyDefinition`). This is what forces staleness when a
   dropped UNIQUE backed the recorded backing PK: `keysOf` no longer proves the
   recorded key, the derived PK shifts (lineage/all-columns fallback) → mismatch
   → stale. No special-casing needed. It also catches CHECK-driven output
   nullability/type narrowing the optimizer may have inferred.
4. `db.registerMaterializedView(mv)` — throws (non-determinism gate, bag/no-key
   floor reject, `isFullRebuildPathological` against fresh stats) → stale.

On success the MV stays live: `stale` untouched (it was false), **no**
`emitBackingInvalidation` (the backing stays maintained, so cached plans reading
it remain correct; cached plans reading the *source* invalidate via their own
direct statement dependency on the source table). On ANY failure, fall back to
today's path verbatim: `stale = true`, `releaseRowTime`,
`emitBackingInvalidation`, with a log line naming the reason.

Known acceptable conservatisms (document in code, don't fix here): an
`ADD CONSTRAINT UNIQUE` that reorders `keysOf`'s first proved key fails the
strict PK equality → stale fallback (no worse than today; a follow-up could
relax to "recorded backing PK is a superkey of some proved key"); ANALYZE
revealing a full-rebuild source grew past the rebuild threshold → registration
throws → stale (defensible: the alternative is unbounded per-write rebuild cost).

**Body-irrelevant classifier.** `table_modified` qualifies for the recompile
path iff ALL of:

- `event.oldObject !== event.newObject` (reference inequality) — see synthetic
  events below;
- names match: `oldObject.name`/`newObject.name` equal lowercased, same
  `schemaName` (a table rename is never body-irrelevant; in practice the rename
  event's old/new names differ);
- columns pairwise identical in the body-relevant fields: `name` (lowercased),
  `logicalType` (compare by `.name`), `notNull`, `collation` (absent ⇒
  `BINARY`), `generated` flag + generated expression (compare via
  `expressionToString` when present). Reuse the existing per-column predicates
  in materialized-view-helpers (`backingTypeMatches`, `backingNotNullMatches`,
  `backingCollationMatches`) plus name/generated checks. `defaultValue` and
  per-column conflict metadata are deliberately IGNORED (a body reads stored
  values, never source defaults; the recompile-not-skip discipline covers any
  optimizer concern);
- `primaryKeyDefinition` pairwise identical (`index`, `desc`, `collation`).

Everything else may differ: `checkConstraints`, `foreignKeys`,
`uniqueConstraints`, `indexes`, `statistics`, `estimatedRows`, `tags`,
`primaryKeyDefaultConflict`, etc.

**Synthetic invalidation events keep the stale cascade.**
`emitBackingInvalidation` fires `table_modified` on the MV's own backing with
the SAME object as `oldObject` and `newObject`. That event is load-bearing for
cascading staleness down MV-over-MV chains and must NOT classify as
body-irrelevant — hence the reference-equality guard above. Add a comment on
BOTH sides (in `emitBackingInvalidation` and in the classifier) naming this
coupling so neither drifts. Every genuine emitter passes distinct old/new
objects (verified: alter-table, add-constraint, analyze, tag setters,
renameShiftedBackingColumns, attach-reshape).

**Already-stale dependents skip entirely** on a body-irrelevant event: no plan
to recompile, never clear a pre-existing flag (only REFRESH may — the backing
may be behind), no re-release, no re-emit. The existing
`rebuildConstraintValidatorsFor(changed, true)` call after the loop stays
unchanged and still runs for these events (it IS the constraint-only-dependency
validator rebuild path); a recompiled MV's validator was already rebuilt fresh
inside `registerMaterializedView` — a second rebuild there is idempotent.

## Mechanics

- New exported helper in `materialized-view-helpers.ts`, e.g.
  `tryRecompileMaterializedViewLive(db: Database, mv: MaintainedTableSchema): boolean`
  — fully **synchronous** (the change-notifier listener is sync;
  `deriveBackingShape`, schema lookups, and `registerMaterializedView` all are).
  Never throws; logs and returns false on failure. Do NOT reuse
  `restoreMaterializedViewLive` (async, clears `stale` — wrong discipline here).
- New exported classifier in the same file, e.g.
  `isBodyIrrelevantTableChange(oldObject: TableSchema, newObject: TableSchema): boolean`
  (including the reference-equality guard), colocated with the per-column
  predicates it reuses.
- `subscribeToSchemaChanges` (`database-materialized-views.ts`): inside the
  `table_modified` branch (NOT `table_removed`), compute the classification once
  per event; in the dependent loop route live dependents through the recompile
  helper (cast `this.ctx as unknown as Database`, the file's existing pattern),
  falling back to the existing stale block. Update the module/class doc comments
  describing responsibility 1 (staleness).
- Update `docs/materialized-views.md`'s schema-change staleness section: a
  columns/PK-identical source change recompiles in place; enumerate the
  stale-fallback causes.

## Edge cases & interactions

- **MV-over-MV cascade preserved**: when a recompile fails and the MV stales,
  its `emitBackingInvalidation` re-enters the listener (nested notify) with
  `oldObject === newObject` → classified body-relevant → consumers stale.
  Terminates (derivation DAG is acyclic).
- **Rename-propagation composition**: cascade `table_modified` events from
  `rewriteTableForTableRename`/`rewriteTableForColumnRename` on other tables are
  body-irrelevant → their dependents now recompile inline and never go stale, so
  `restoreUnaffectedMaterializedViews` (filter: `stale && !preStale`) simply
  finds nothing for them — test 53.2 §11/§13 must keep passing via the new path.
- **MV reading BOTH the constraint-rewritten table and the renamed table**: at
  cascade-event time the catalog holds the new table name while the MV body
  still says the old one → `deriveBackingShape` throws → stale fallback → the
  rename propagation's own MV loop later rewrites the body and restores it live.
  Needs a test.
- **Mid-statement failure independence**: with several dependents, one failed
  recompile stales only that MV; the others stay live.
- **Statement-cache**: a plan compiled against the source invalidates via its
  own direct table dependency; a plan reading the MV's backing needs no
  invalidation when the MV stays live (backing content/maintenance unchanged).
- **Idempotent re-registration**: `registerMaterializedView` releases the old
  plan and re-indexes `rowTimeBySource`; calling it for an already-registered MV
  is the existing re-register pattern (rename propagation does the same).
- **Listener reentrancy**: the recompile path must not fire schema-change
  events on success (it doesn't — registration is event-silent).
- **`table_removed` / `materialized_view_removed` / `table_added` branches
  unchanged.**
- **Store-backed modules** (`yarn test:store`): ALTER routes through
  `module.alterTable` and fires the same events with distinct old/new objects;
  rehydrate-time event oddities fall back to stale — never worse than today.

## Tests

New `packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic`
(idiom: 53.2 — assert liveness by writing to the source and reading the MV;
assert staleness via `-- error: is stale` on read):

- **DROP CONSTRAINT (CHECK) keeps MV live**: MV over `t`; `alter table t drop
  constraint c`; insert into `t` → row appears in MV.
- **RENAME CONSTRAINT keeps MV live**; same for **ADD CONSTRAINT CHECK** and an
  **ADD UNIQUE on an unprojected column** (cannot move the projected key set).
- **CHECK-fold soundness (the recompile-not-skip proof)**: source CHECK that
  contradicts the body WHERE (e.g. CHECK `v > 10`, body `where v < 5`) so the
  compiled plan folds to empty; drop the CHECK; insert `v = 3` → the row MUST
  appear in the MV (a stale compiled plan would stay empty forever).
- **FK-drop demotes the join-residual arm**: MV over a provable 1:1 join
  (`T join P on T.fk = P.id`, fk NOT NULL REFERENCES); `alter table T drop
  constraint <fk>`; MV stays live; `delete from P` of a referenced row → the
  joined MV rows disappear (under the stale upsert-only lookup side they'd
  linger); insert a dangling `T` row → no MV row.
- **Dropped UNIQUE that backed the recorded backing PK forces staleness**:
  `t(id integer primary key, u text unique, v ...)`; MV `select u, v from t`
  (backing keyed on `u` via the UNIQUE; `id` unprojected); drop the UNIQUE →
  `select * from mv` errors `is stale`.
- **ANALYZE keeps MVs live**: create MV, `analyze t` (or `analyze`), then write
  to `t` → propagates; read succeeds with no staleness diagnostic.
- **Pre-existing staleness never cleared**: make an MV stale (e.g. drop+recreate
  a source, or alter a projected column), then run a constraint-only DDL on its
  source → still stale.
- **MV-over-MV**: constraint-only DDL on the base source keeps BOTH levels live;
  and a forced recompile failure path still cascades staleness to the consumer
  (cover via the dropped-UNIQUE shape with a consumer MV on top).
- Existing suites must stay green, notably 53.2 (§10–§13 restore pass),
  41.6 (drop/rename constraint), 50 (declarative schema).

## TODO

- Add `isBodyIrrelevantTableChange` (with reference-equality guard) to
  materialized-view-helpers.ts, reusing the per-column match predicates.
- Add synchronous `tryRecompileMaterializedViewLive` (derive shape →
  sourceTables guard → `describeBackingShapeMismatch` → register; catch-all →
  false) to materialized-view-helpers.ts.
- Rework the `table_modified` arm of `subscribeToSchemaChanges` to route live
  dependents through recompile with stale fallback; skip already-stale
  dependents on body-irrelevant events; leave `table_removed` and the
  validator-rebuild tail unchanged.
- Cross-reference comments: `emitBackingInvalidation` ↔ classifier
  (same-object payload contract).
- Write 53.3 sqllogic suite per the test list above.
- Update docs/materialized-views.md staleness section.
- `yarn build`, `yarn test` (and lint in packages/quereus) green.
