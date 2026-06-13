----
description: Keep provably-unaffected dependent MVs live across non-rename structural source ALTERs (ADD/DROP/ALTER COLUMN) by extending the listener's shape-rederivation recompile gate with a content-stability (column-disjointness) proof, instead of always marking every dependent stale.
difficulty: hard
files:
  - packages/quereus/src/core/database-materialized-views.ts          # subscribeToSchemaChanges listener
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts     # tryRecompileMaterializedViewLive, isBodyIrrelevantTableChange, deriveBackingShape
  - packages/quereus/src/planner/nodes/reference.ts                    # ColumnReferenceNode.attributeId, TableReferenceNode.getAttributes/getColumnIndexForAttribute
  - packages/quereus/src/schema/table.ts                               # generatedColumnDependencies
  - packages/quereus/src/core/database.ts                              # _buildPlan (un-optimized plan), getPlan
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic   # sibling test to mirror
----

# Keep provably-unaffected MVs live across structural source ALTERs

## Problem

A `table_modified` whose column list/attributes changed (ADD COLUMN, DROP
COLUMN, ALTER COLUMN SET DATA TYPE / SET·DROP NOT NULL / SET COLLATE) currently
marks **every** dependent MV stale, even when the MV body provably never reads
the altered column — e.g. `create materialized view mv as select id, u from t`
followed by `alter table t add column w int` or `alter table t drop column v`
(where `v ∉ {id,u}` and the body never names it). The body re-plans to the
identical backing shape and identical content, so the MV could stay live and keep
maintaining writes — instead it freezes until a `REFRESH`.

This is the structural-ALTER generalization of the two existing live-restore
disciplines:
- `tryRecompileMaterializedViewLive` (constraint/stats/tags-only `table_modified`
  — `isBodyIrrelevantTableChange`): re-derives the backing shape at the listener
  and recompiles the live row-time plan in place, gated by shape match + source
  set + superkey PK.
- `restoreUnaffectedMaterializedViews` (statement-local rename-propagation pass):
  re-derives after the statement and re-lives MVs a rename provably did not
  affect.

## Why this is NOT a trivial follow-on (the soundness gap)

For a **constraint-only** change the soundness argument is "constraints can't
change body *results*, only what the body *compiles* to" — so shape identity
implies content identity, and a recompile against the new catalog is enough.
**That argument does not carry over to structural ALTERs**: re-derived shape
identity does NOT imply the backing content still equals a fresh body evaluation.
The classic counterexample is `alter column v set collate nocase` (or `set data
type`) on a column the body uses only in a `where`/join/group/order position:
the body's output *shape* is unchanged (v is unprojected), but the row set the
predicate admits — hence the backing content — changes. The recompile must
therefore additionally prove the value-semantics of the change is **disjoint**
from everything the body reads.

## Case analysis (the resolved design)

Classify each structural change by whether it can alter body *content* without
altering body *output shape*. Define the **value-semantics-changed column set**
of an `oldObject → newObject` transition as the columns present **by name in
both** whose **logical type or collation differs**. NOT NULL changes, default
changes, generated-expr-unchanged, add/drop are deliberately excluded — see
below.

- **ADD COLUMN.** The new column did not exist when the body was authored, so the
  body cannot reference it (directly, in a predicate, or as a generated-column
  dependency — it is brand new), and adding it changes no existing row's existing
  values. So **shape match + same sources ⇒ content stable.** A `select *` body
  re-derives to *more* columns ⇒ shape mismatch ⇒ stale (the shape gate catches
  it). The value-semantics-changed set is empty.

- **DROP COLUMN.** If the body references the dropped column **directly**,
  `deriveBackingShape` fails to re-plan (name resolution error) ⇒ stale. If a
  **generated** column depends on it, `runDropColumn` *rejects the ALTER itself*
  (`generatedColumnDependencies` guard), so a successful drop means no generated
  column reads it. So **successful re-derivation + shape match + same sources ⇒
  content stable.** A `select *` body re-derives to fewer columns ⇒ shape
  mismatch ⇒ stale. The value-semantics-changed set is empty.

- **ALTER COLUMN SET·DROP NOT NULL.** NOT NULL is a *constraint*: tightening it
  cannot change an existing value (a violating row would have aborted the ALTER),
  loosening it cannot either. So it is content-irrelevant. If the column is
  **projected**, output nullability shifts ⇒ shape mismatch ⇒ stale anyway; if
  unprojected, the shape gate passes and the MV stays live. The value-semantics-
  changed set is empty (we exclude NOT NULL from it).

- **ALTER COLUMN SET·DROP DEFAULT.** Already body-irrelevant today
  (`bodyRelevantColumnMatches` ignores `defaultValue`) — `isBodyIrrelevantTableChange`
  returns true, handled by the existing recompile path. The value-semantics-changed
  set is empty.

- **ALTER COLUMN SET DATA TYPE / SET COLLATE.** The **only** case where shape
  identity does not imply content identity. The column survives (name unchanged),
  so the body still plans and re-derives; if the column is **projected**, output
  type/collation shifts ⇒ shape mismatch ⇒ stale. The hazard is the **unprojected
  but read** column (WHERE / join key / group / order / inside a projected
  expression / a generated column the body reads): output shape is identical but
  content changes. Here the value-semantics-changed set is non-empty and we run
  the **disjointness proof**: keep live **iff** no value-semantics-changed column
  is read by the body (transitively through generated columns).

This collapses to one unified gate, because the value-semantics-changed set is
**empty** for every case except ALTER COLUMN type/collation — so the disjointness
proof is a no-op (and preserves today's behavior exactly) for constraint-only,
ADD, DROP, NOT NULL, and DEFAULT changes, and does real work only for the rare
type/collation change.

## The unified content-stability gate

Extend `tryRecompileMaterializedViewLive(db, mv)` to
`tryRecompileMaterializedViewLive(db, mv, oldObject, newObject)`. After its
existing gates pass (re-derive shape → throws ⇒ stale; `sameSourceTables` ⇒ else
stale; `describeBackingShapeMismatch` + superkey relaxation ⇒ else stale), add a
final **content-stability gate**:

```
valueChanged = { col.name : col in oldObject∩newObject by name,
                 type(old) ≠ type(new) OR collation(old) ≠ collation(new) }
if valueChanged is empty:          # constraint-only, ADD, DROP, NOT NULL, DEFAULT
    keep live (today's behavior)
else:                              # ALTER COLUMN type/collation
    read = referenced source columns of S the body reads (transitive closure
           over S.generatedColumnDependencies)
    if valueChanged-as-indices ∩ read is non-empty: return false   # stale
    else: keep live
```

`S` is the changed source table, `${newObject.schemaName}.${newObject.name}`.

### Computing the body's referenced source-column set (the new analysis)

Build a NEW helper in `materialized-view-helpers.ts`, e.g.
`referencedSourceColumns(db, bodySql, qualifiedSource): Set<number>` (column
indices in the **post-ALTER** `newObject` schema):

- Plan the body with the **un-optimized** builder (`db._buildPlan([ast])`, NOT
  `db.getPlan` which optimizes), wrapped in
  `schemaManager.withSuppressedMaterializedViewRewrite`. **Why un-optimized:** the
  optimizer can absorb a `where v = 'x'` predicate into an access-method seek key,
  dropping the explicit `ColumnReferenceNode` from the tree — walking the optimized
  plan would *miss* the reference and falsely conclude disjoint (UNSOUND). The
  un-optimized built plan carries every reference explicitly in
  projection/filter/join/group/order nodes. Over-approximation is the safe
  direction (it only ever causes *more* staleness).
- Walk the plan (children **and** relations, like `collectSourceTables`, so nested
  subqueries / EXISTS / correlated refs are reached). Collect every
  `ColumnReferenceNode.attributeId` (see `reference.ts` — `attributeId` is the
  stable handle).
- Find every `TableReferenceNode` whose `tableSchema` qualified name equals `S`
  (there may be several for a self-join). For each, its `getAttributes()[i].id`
  is column `i`'s attribute id; `getColumnIndexForAttribute(id)` reverses it.
  Intersect the collected `ColumnReferenceNode` attribute ids with each `S`
  occurrence's attribute ids and map back to a column-index set (union over
  occurrences).
- **Generated-column transitive closure.** If a referenced column is generated,
  the change to one of its dependency columns changes its value even though the
  body never names the dependency. Expand the referenced set downward through
  `newObject.generatedColumnDependencies` (Map<genIdx, depIndices[]>) to a fixed
  point (a dependency may itself be generated). This is safe regardless of
  whether the planner inlines generated columns (if it does, the dep already
  appears as a direct `ColumnReferenceNode` and the closure is a harmless no-op;
  if it doesn't, the closure is load-bearing).

### Listener change (`subscribeToSchemaChanges`)

Widen the recompile attempt from the body-irrelevant branch to **any genuine**
`table_modified` (distinct old/new objects), while preserving every existing
behavior. `isBodyIrrelevantTableChange` is retained **only** to decide the
already-stale skip (whose semantics differ between the two cases):

```
const genuine = event.type === 'table_modified' && event.oldObject !== event.newObject;
const bodyIrrelevant = genuine && isBodyIrrelevantTableChange(event.oldObject, event.newObject);
for (const mv of getAllMaintainedTables()) {
  if (!mv.derivation.sourceTables.includes(changed)) continue;
  // constraint-only + already-stale: skip entirely (no re-emit) — today's behavior.
  if (bodyIrrelevant && mv.derivation.stale) continue;
  // genuine source change + live: try to keep live (shape + content gate).
  if (genuine && !mv.derivation.stale
      && tryRecompileMaterializedViewLive(db, mv, event.oldObject, event.newObject)) continue;
  // fall through: mark stale + releaseRowTime + emitBackingInvalidation (unchanged).
  ...
}
```

The truth table this realizes (all four rows must match the stated behavior):
- constraint-only + live → recompile, empty valueChanged ⇒ no-op disjointness ⇒ today's behavior.
- constraint-only + already-stale → `continue` (skip, no re-emit) ⇒ today's behavior.
- structural + live → recompile WITH disjointness gate ⇒ **NEW** (keep live when disjoint).
- structural + already-stale → fall through to mark-stale + re-emit ⇒ today's behavior.

### Why the listener (synchronous), not the statement-local pass

In every keep-live case the body **output** is unchanged (ADD/DROP/ALTER of an
unreferenced column never shifts the projected columns), so the backing shape is
unchanged and **no async backing mutation is needed** — the synchronous in-place
re-register (exactly `tryRecompileMaterializedViewLive`'s discipline: MV live
throughout, `stale` untouched, no backing invalidation) is correct. This mirrors
the deliberate choice the constraint-only ticket made over the async
`restoreMaterializedViewLive`/`restoreUnaffectedMaterializedViews` path; no
`snapshotStaleMaterializedViews`/`restoreUnaffectedMaterializedViews` plumbing is
added to the add/drop/alter-column emitters.

## Edge cases & interactions

- **Same-object cascade signal must NOT be recompiled.** `emitBackingInvalidation`
  fires a synthetic `table_modified` with `oldObject === newObject` to cascade
  staleness down MV-over-MV chains. The `event.oldObject !== event.newObject`
  guard (already the first line of `isBodyIrrelevantTableChange`) excludes it from
  the recompile attempt so it still falls through to mark-stale + re-emit. **This
  is the one hard constraint** — a regression here silently freezes MV-over-MV
  consumers' liveness incorrectly (or, worse, keeps them live when they should
  cascade-stale). Add an explicit MV-over-MV structural-ALTER test (see TODO).

- **`select *` body on ADD/DROP COLUMN** → re-derived shape gains/loses a column
  ⇒ `describeBackingShapeMismatch` ⇒ stale. The superkey relaxation must NOT
  rescue it (column count differs). Verify it stales.

- **ALTER COLUMN SET COLLATE on a WHERE-only column** (shape identical) → must
  stale. The canonical content-changes-but-shape-doesn't proof. Test with NOCASE
  flipping which rows the predicate admits, then a write, and confirm the MV is
  frozen (and `REFRESH` recovers).

- **ALTER COLUMN SET DATA TYPE on a projected column** → output type shifts ⇒
  shape mismatch ⇒ stale (also caught by disjointness — column is referenced).

- **ALTER COLUMN SET DATA TYPE / SET COLLATE on a fully unreferenced column** →
  empty intersection ⇒ keep live; subsequent writes propagate.

- **Generated-column indirection.** Body projects generated `g = f(v)` but never
  names `v`; `alter column v set data type` → `v` is in valueChanged AND in the
  closure of `read` (via `generatedColumnDependencies`) ⇒ stale. Without the
  closure this would be UNSOUND (keep live with stale `g` values). Dedicated test.

- **DROP of a referenced column** → `deriveBackingShape` throws ⇒ stale (outer
  try/catch). DROP of a generated-dep column is rejected by `runDropColumn`
  before any event fires (no MV interaction).

- **Self-join over the altered source** (`from t a join t b …`): two
  `TableReferenceNode`s for `t`, distinct attribute ids; the referenced set is the
  union over both occurrences. A column read through *either* alias counts.

- **Multi-dependent statement independence.** One ALTER, two dependents: one reads
  the altered column (stales), the sibling does not (stays live) — mirror case 9
  of 53.3.

- **Pre-existing staleness is never cleared.** A structural ALTER on a source of an
  already-stale MV must leave it stale (only `REFRESH` clears) — the `!mv.derivation.stale`
  guard ensures this; mirror case 8 of 53.3.

- **Source-set drift / CHECK-contradiction fold** still routes to stale via the
  existing `sameSourceTables` gate (unchanged) — a structural ALTER that re-folds
  the plan's source set keeps that protection.

- **Build failure during the disjointness analysis** (un-optimized plan throws for
  any reason) → treated as "could not prove disjoint" ⇒ return false ⇒ stale. The
  outer try/catch in `tryRecompileMaterializedViewLive` already provides this;
  ensure the new helper's exceptions propagate to it rather than being swallowed
  into a false "disjoint" conclusion.

- **Store-module path (`yarn test:store`).** The store module rebuilds
  `TableSchema` with fresh type instances after an ALTER; the column comparison
  primitives (`backingTypeMatches` etc.) already compare by interned type name /
  normalized value, not identity, so the valueChanged diff and shape gate work
  there. Not agent-run by default (document the deferral if not run), but the
  design must not assume object identity.

## Key tests & expected outputs

New sqllogic file `packages/quereus/test/logic/53.4-materialized-view-structural-alter-restore.sqllogic`,
mirroring the structure of 53.3. Each section: create source + MV, ALTER, then a
post-ALTER write and a `select` asserting whether the write propagated (live) or
not (frozen), plus a `REFRESH` recovery for the frozen cases.

- ADD COLUMN unreferenced → live (write propagates; the new column is invisible to
  the MV).
- ADD COLUMN with a `select *` body → frozen; `REFRESH` reshapes.
- DROP COLUMN unreferenced → live.
- DROP COLUMN referenced (in projection / in WHERE) → frozen; `REFRESH` recovers
  or errors with the shape/plan diagnostic as appropriate.
- DROP COLUMN with a `select *` body → frozen.
- ALTER COLUMN SET DATA TYPE on an unprojected, **unreferenced** column → live.
- ALTER COLUMN SET DATA TYPE on a **projected** column → frozen; `REFRESH`
  reshapes (parity with case 8 of 53.3).
- ALTER COLUMN SET DATA TYPE on an unprojected **WHERE** column → frozen.
- ALTER COLUMN SET COLLATE on an unprojected **WHERE** column (NOCASE flips the
  admitted row set) → frozen; demonstrate the content divergence the keep-live
  path would have produced.
- ALTER COLUMN SET COLLATE on a fully unreferenced column → live.
- ALTER COLUMN SET·DROP NOT NULL on an unprojected column → live.
- ALTER COLUMN SET NOT NULL on a projected column → frozen (output nullability
  shift).
- Generated column: body projects `g` (generated from `v`), ALTER COLUMN v type →
  frozen (closure proof).
- Self-join over the altered source, altered column read via one alias → frozen.
- Two dependents, one reads the altered column / one does not → independence.
- Pre-existing stale + structural ALTER → stays stale.
- MV-over-MV: structural ALTER on the base that keeps the producer live keeps both
  levels live (no spurious cascade); a structural ALTER that stales the producer
  cascades via `emitBackingInvalidation` (same-object guard intact).

Spec-level coverage (catalog invariants the sqllogic can't see) — extend an
existing spec or add `packages/quereus/test/mv-structural-alter-restore.spec.ts`:
- A live keep-live ALTER fires **no** `materialized_view_modified` and **no**
  backing-invalidation `table_modified` (the recompile path is event-silent), and
  the row-time plan object is freshly registered (maintenance keeps working).
- A frozen ALTER releases the row-time plan and the MV reads stale until `REFRESH`.
- The `oldObject !== newObject` guard: assert the synthetic backing-invalidation
  event is not intercepted by the new recompile attempt (MV-over-MV cascade
  still stales the consumer when the producer goes stale).

## TODO

- Add `referencedSourceColumns(db, bodySql, qualifiedSource): Set<number>` to
  `materialized-view-helpers.ts`: un-optimized `db._buildPlan` (rewrite-suppressed),
  full children+relations walk collecting `ColumnReferenceNode.attributeId`,
  map via the source `TableReferenceNode`(s) `getAttributes()` /
  `getColumnIndexForAttribute`, then transitive closure over
  `newObject.generatedColumnDependencies`.
- Add `valueSemanticsChangedColumns(oldObject, newObject): Set<string>` (type or
  collation differs for a same-name column; excludes add/drop/notnull/default) —
  reuse `backingTypeMatches` / `backingCollationMatches`.
- Extend `tryRecompileMaterializedViewLive` signature to take `oldObject, newObject`
  and run the content-stability gate as the final gate (no-op when the changed set
  is empty; disjointness proof otherwise). Update its docstring to state the
  structural-ALTER soundness argument (shape identity ⇏ content identity; the
  disjointness proof closes the gap).
- Update the only caller (`subscribeToSchemaChanges` in
  `database-materialized-views.ts`) to the widened listener logic above; keep
  `isBodyIrrelevantTableChange` for the already-stale-skip decision and the
  same-object cascade guard. Update the listener's block comment to describe the
  structural keep-live path alongside the constraint-only one.
- Update `docs/materialized-views.md` (staleness / recompile section) to document
  the structural-ALTER keep-live path and the disjointness/closure soundness
  argument.
- Tests: new `53.4-…` sqllogic + spec coverage above. Run `yarn test` (stream with
  `tee`); run lint (`packages/quereus`). Note `yarn test:store` deferral if not run.
