description: Review the structural-ALTER keep-live feature for materialized views — a genuine source `table_modified` (ADD/DROP/ALTER COLUMN) now recompiles a live dependent MV in place (instead of always marking it stale) when the change is provably disjoint from everything the body reads, gated by a shape check, a NEW name-stability check, and a content-stability (column-disjointness) proof.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # referencedSourceColumns, valueSemanticsChangedColumns, expandGeneratedDependencyClosure, tryRecompileMaterializedViewLive (extended), name-stability gate
  - packages/quereus/src/core/database-materialized-views.ts                 # subscribeToSchemaChanges listener (widened to any genuine table_modified)
  - docs/materialized-views.md                                              # § Schema-change staleness: new "Structural ALTERs keep provably-unaffected dependents live" paragraph
  - packages/quereus/test/logic/53.4-materialized-view-structural-alter-restore.sqllogic   # NEW — 17 sections
  - packages/quereus/test/mv-structural-alter-restore.spec.ts                # NEW — 4 catalog-invariant cases
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic       # § 16 staling trigger changed (add-col → collate g)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts      # staling trigger changed (add-col → collate g + WHERE)
  - packages/quereus/test/mv-converge-all.spec.ts                            # staling trigger changed
  - packages/quereus/test/mv-rename-propagation.spec.ts                      # staling trigger changed (add-col → retype v)
  - packages/quereus/test/covering-structure.spec.ts                        # one test rewritten to the keep-live behavior
  - packages/quereus/test/plan/materialized-view-plan.spec.ts                # staling triggers changed (add-col → drop not null)
  - packages/quereus/test/plan/materialized-view-rewrite-plan.spec.ts        # staling trigger changed (add-col → retype amt)
  - packages/quereus/test/query-rewrite.spec.ts                             # staling trigger changed
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                    # staling trigger changed
  - packages/quereus/test/query-rewrite-join.spec.ts                         # staling triggers changed (×2)

# Review: keep provably-unaffected MVs live across structural source ALTERs

## What landed

A `table_modified` on a source whose **columns/PK changed** (ADD / DROP / ALTER COLUMN
type·collation·not-null·default) no longer unconditionally marks every dependent MV
stale. The MV-manager listener now routes **any genuine** `table_modified`
(`oldObject !== newObject`) of a *live* dependent through
`tryRecompileMaterializedViewLive`, which keeps it live iff the change is provably
unaffecting. This generalizes the constraint-only recompile path (53.3) to structural
ALTERs.

### The gate chain in `tryRecompileMaterializedViewLive(db, mv, oldObject, newObject)`
1. `deriveBackingShape` re-plans the body against the post-change catalog (throws ⇒ stale).
2. `sameSourceTables` (re-planned source set must equal the recorded one).
3. `describeBackingShapeMismatch` + superkey relaxation (existing — handles projected
   type/collation/not-null shifts, dropped UNIQUE, ADD UNIQUE subsuming the key).
4. **NEW name-stability gate** — re-derived output column NAMES must still equal the
   existing backing's. `describeBackingShapeMismatch` is name-blind (it serves the
   rename pass's pure-positional-name-shift detection), so a column RENAME under a
   `select *`-style body re-derives a name-blind-identical shape; keeping it live would
   leave the backing column under its OLD name. Declining hands the backing rename to
   the existing rename-propagation pass.
5. **NEW content-stability gate** — `valueSemanticsChangedColumns(oldObject,newObject)`
   (same-name columns whose logical type OR collation differs; NOT NULL / default /
   add / drop excluded) ∩ `referencedSourceColumns(db, bodySql, source)` must be empty.
   The read set is collected from the **un-optimized** built plan (`db._buildPlan`, NOT
   `getPlan` — the optimizer can absorb a `where v='x'` into a seek key and drop the
   `ColumnReferenceNode`, which would be UNSOUND), then expanded downward through
   `generatedColumnDependencies` to a fixed point. Empty changed set ⇒ no-op (preserves
   today's behavior for constraint-only / ADD / DROP / NOT NULL / DEFAULT).

The keep-live path is event-silent (no `materialized_view_modified`, no backing
invalidation), so an unaffected MV-over-MV consumer sees no spurious cascade. The
`oldObject !== newObject` guard keeps `emitBackingInvalidation`'s synthetic same-object
event OUT of the recompile, so a genuinely-stale producer still cascade-stales consumers.

## ⚠️ Deviations from the plan — scrutinize these first

1. **The name-stability gate (step 4) is NOT in the original ticket.** It was added
   during implementation because the ticket's design only had shape + content gates, and
   the name-blind `describeBackingShapeMismatch` let a `select *` body keep-live across a
   column RENAME with a stale backing column name (regression caught by
   `53.2-materialized-view-rename-propagation.sqllogic` § 12). Verify the gate is
   correct and neither over-declines (a legit keep-live whose output names happen to
   match) nor under-declines. Soundness argument: the recompile re-registers against the
   **existing** backing, so output names must match the backing's; a rename is the only
   structural change that shifts them while passing the (name-blind) shape gate.

2. **Wide test-file fallout — the biggest review surface.** ~9 existing test files
   encoded "an unreferenced/benign source ALTER (usually `add column`) marks the
   dependent MV stale". That is exactly the behavior this feature INVERTS, so each had to
   switch to a *genuinely-staling* trigger (or be rewritten to the new keep-live
   expectation). Confirm each still validates its ORIGINAL intent, not a hollowed-out
   version:
   - `53-materialized-views-rowtime.sqllogic` § 16, `maintained-table-refresh-revalidation.spec.ts`,
     `mv-converge-all.spec.ts`, `query-rewrite*.spec.ts`: trigger changed to a
     value-semantics ALTER on an unprojected column the body reads in a `where g <> 'skip'`
     (added column `g`) **or** a retype/drop-not-null on a projected column. The
     refresh-reregister / stale-not-matched / drift-validation intents are preserved, but
     the reviewer should confirm the new triggers genuinely exercise the same code paths
     (e.g. the "byte-identical fast path" tests must still take the non-reshape path —
     they do, because the body's output shape is unchanged).
   - `covering-structure.spec.ts`: "covering enforcement resumes after refresh following a
     compatible source ALTER" was REWRITTEN to "stays live across a compatible,
     unreferenced source ALTER" — its premise (add-column stales → enforcement pauses) is
     gone. The refresh-reregister-after-detach coverage it lost is now in
     `mv-structural-alter-restore.spec.ts`.
   - `mv-rename-propagation.spec.ts`: staling add-column swapped for a projected-column
     retype; the 3-value inserts that depended on the added column were reduced to
     2-value. Confirm the rename-survives-staleness intent is intact.

## Soundness — the core argument to verify

For a **constraint-only** change, re-derived shape identity ⇒ content identity (a
constraint can't change stored values, only what the body compiles to). For a
**structural** ALTER this does NOT hold: `alter column v set collate nocase` / `set data
type` on a column read only in a WHERE/join/group/order position leaves the output shape
unchanged while changing the admitted row set / values. The disjointness proof closes
that gap. Adversarial angles worth probing:
- A predicate the optimizer would fold/absorb such that the un-optimized walk still
  catches the reference (it must — over-approximation is the safe direction). Check CTEs,
  set-ops, EXISTS/correlated subqueries, lateral TVFs reach the walk (children+relations,
  like `collectSourceTables`).
- A generated column whose dependency the body never names (closure must catch it —
  53.4 § 13). Confirm `generatedColumnDependencies` is read from the **post-ALTER**
  `newObject` (the TableReferenceNode's `tableSchema` is the live catalog).
- A self-join over the altered source: the read set must union over BOTH occurrences
  (53.4 § 14).

## Key behaviors & expected outputs (53.4 sqllogic — all 17 sections pass)

- ADD COLUMN unreferenced → **live**; `select *` body → **frozen**, REFRESH reshapes.
- DROP COLUMN unreferenced → **live**; referenced (projection) → **frozen** (re-derive
  throws), reading errors "drop and recreate"; `select *` → frozen.
- ALTER COLUMN SET DATA TYPE: unprojected+unreferenced → **live**; projected → frozen
  (shape); unprojected WHERE column → **frozen** (content gate — the new work).
- ALTER COLUMN SET COLLATE: unprojected WHERE column (NOCASE flips admitted rows) →
  **frozen**, REFRESH recovers under the new collation; fully unreferenced → **live**.
- DROP NOT NULL unprojected → **live**; SET NOT NULL projected → frozen (shape).
- Generated-column indirection (body projects `g=f(v)`, ALTER v) → **frozen** (closure).
- Self-join, altered column read via one alias → **frozen**.
- Two dependents, one reads / one doesn't → independence.
- Pre-existing stale + structural ALTER → stays stale.
- MV-over-MV: keep-live producer keeps both live (no cascade); staling producer cascades
  via the same-object guard.

`mv-structural-alter-restore.spec.ts` locks the catalog invariants the sqllogic can't
see: keep-live is event-silent + maintenance keeps working; a frozen ALTER releases the
plan + emits backing invalidation + REFRESH re-registers maintenance; the same-object
cascade guard.

## Validation done
- `yarn workspace @quereus/quereus run build` → clean.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) → clean.
- `yarn workspace @quereus/quereus run test:all` (memory module, NO bail) → **6183 passing, 9 pending, 0 failing**.

## Known gaps / deferrals
- **`yarn test:store` was NOT run** (slow; not agent-runnable by default). The store
  module rebuilds `TableSchema` with fresh type instances after an ALTER; the comparison
  primitives (`backingTypeMatches`/`backingCollationMatches`) compare by interned type
  name / normalized collation, NOT object identity, and `valueSemanticsChangedColumns`
  follows the same discipline — so the design should hold on the store path, but it is
  UNVERIFIED. A reviewer with the store harness should run 53.3/53.4/51.x under
  `QUEREUS_TEST_STORE=1`.
- The name-stability gate (step 4) is the least-exercised new code: only the `select *`
  rename path drives it (53.2 § 12). Consider an explicit spec asserting a `select *` MV
  over a renamed source goes through the rename-propagation pass (not the recompile) and
  ends live under the new name.
- `referencedSourceColumns` re-parses + re-builds the body (un-optimized) on every genuine
  structural ALTER of a live dependent. For constraint-only / ADD / DROP / NOT NULL /
  DEFAULT changes the content gate short-circuits BEFORE that build (empty `valueChanged`),
  so the cost is paid only on the rare type/collation ALTER — but confirm there's no
  hot-path regression for workloads doing frequent type/collation ALTERs with many live
  dependents.
