description: A maintenance-driven delete/key-update of a maintained table that is the PARENT (FK target) of an FK declared on another table must fire parent-side referential enforcement (RESTRICT / CASCADE / SET NULL / SET DEFAULT) instead of silently orphaning child rows. Wire the EXISTING parent-side referential-action engine into the maintenance write path as a new entry point — do not write a third copy.
files:
  - packages/quereus/src/core/database-materialized-views.ts            # maintainRowTime + flushDeferredRebuilds: the two backing-write sites; validateDerivedChanges is the child-side sibling to mirror
  - packages/quereus/src/runtime/foreign-key-actions.ts                 # the engine: assertTransitiveRestrictsForParentMutation + executeForeignKeyActionsAndLens (reuse as-is)
  - packages/quereus/src/core/database-external-changes.ts              # precedent: a non-DML-executor caller that already replays parent-side FK enforcement over BackingRowChanges
  - packages/quereus/src/core/database.ts                               # _maintainRowTimeCoveringStructures / _flushDeferredRebuilds (the manager already holds `this.ctx as unknown as Database`)
  - packages/quereus/docs/materialized-views.md                         # § facets / external row-change ingestion — document the new parent-side facet of maintenance
  - packages/quereus/docs/incremental-maintenance.md                    # maintenance write-through ordering
difficulty: medium
prereq:
----

# Parent-side referential enforcement for maintained-table derivation writes

## Problem

A maintained (materialized) table `M` whose backing rows are written by **steady-state
maintenance** can be the **parent** (FK target) of a foreign key declared on an ordinary
table `C` (`create table C (... references M(col) on delete cascade|restrict|set null)`).

When a source write drives maintenance to **delete** or **key-update** a derived row in
`M`, the delta is applied straight to `M`'s backing transactional layer
(`applyMaintenancePlan` → `MaintenanceOp`s). That write never runs **parent-side** FK
enforcement, so the change can leave orphaned rows in `C`, silently violating `C`'s FK and
bypassing the declared RESTRICT / referential action.

This is the dual of the already-landed **child-side** validation
(`maintained-table-derivation-check-fk-validation`): that path validates FKs/CHECKs
declared **on** `M` over each written row image (`validateDerivedChanges` →
`derivedRowValidator`). This ticket covers FKs declared **elsewhere** that **reference** `M`.

## Resolved design — reuse the existing engine, add an entry point

Triage (human sign-off, 2026-06-12) mandated **full referential actions**, designed as a
**generalization** of the existing parent-side machinery — *one* referential-action engine
with multiple entry points, **not a third copy**.

That engine already exists and is already shared:

- `assertTransitiveRestrictsForParentMutation(db, parentTable, op, oldRow, newRow?, lensRouted?)`
  — pre-walks the transitive cascade closure and throws on any RESTRICT child (physical +,
  when lens-routed, logical).
- `executeForeignKeyActionsAndLens(db, parentTable, op, oldRow, newRow?, lensRouted?)`
  — executes declared CASCADE / SET NULL / SET DEFAULT (physical + logical), re-entering
  the DML executor via `_execWithinTransaction` for each cascaded child write.

It already has **two** callers beyond the DML executor's own write path:
`database-external-changes.ts` (sync-inbound replication / host direct-store writes) invokes
exactly these two functions over `BackingRowChange`s for writes that bypass the executor.
**The maintenance write path is simply a third such caller.** No engine changes.

### Where to hook (mirror the child-side sibling)

The maintained table's own backing writes surface as the `BackingRowChange[]` returned by
`applyMaintenancePlan` / `applyFullRebuild`. The child-side validator already runs over
exactly that array, at **both** backing-write sites:

- `maintainRowTime` (bounded-delta + inline arms) — after `applyMaintenancePlan`, the block
  guarded by `if (plan.derivedRowValidator)` (database-materialized-views.ts ~line 787).
- `flushDeferredRebuilds` (the deferred full-rebuild arm) — after `applyFullRebuild`, the
  same `if (plan.derivedRowValidator)` block (~line 847).

Add a sibling private method on `MaterializedViewManager`, e.g.
`enforceParentSideReferentialActions(plan, backingChanges, cache?)`, invoked at **both**
sites alongside `validateDerivedChanges`. It mirrors `validateDerivedChanges`' shape:

```
private async enforceParentSideReferentialActions(
    plan: MaintenancePlan,
    changes: readonly BackingRowChange[],
): Promise<void> {
    const db = this.ctx as unknown as Database;            // same cast validateDerivedChanges uses
    if (!db.options.getBooleanOption('foreign_keys')) return;   // cheap gate (engine also early-returns)
    const parent = this.ctx.schemaManager.getTable(plan.backingSchema, plan.backingTableName);
    if (!parent) return;                                   // backing gone ⇒ MV already broken
    for (const change of changes) {
        if (change.op === 'insert') continue;              // inserts have no parent-side actions
        // RESTRICT walk POST-application (the backing delta already landed in the pending
        // layer; child rows it keys off still exist — the cascade has not run yet). Exactly
        // the external-changes ordering. lensRouted = false: a maintenance backing write is
        // a physical basis write (maintained tables are not lens basis spines).
        await assertTransitiveRestrictsForParentMutation(db, parent, change.op, change.oldRow, change.newRow);
        await executeForeignKeyActionsAndLens(db, parent, change.op, change.oldRow, change.newRow);
    }
}
```

Key facts that make this sound (verified against the code):

- **`parent` is the backing `TableSchema`** returned by `getTable(plan.backingSchema,
  plan.backingTableName)` — the same object `validateDerivedChanges` resolves. Its `.name`
  equals `M`'s name, so an FK on `C` (`references M`) matches the engine's
  `fk.referencedTable === parentTable.name` scan, and `resolveReferencedColumns(fk, parent)`
  indexes against `M`'s columns.
- **`backingChanges` carry full `M` rows** in backing column order (the child-side path
  already reads `change.newRow` as a full image), so reading referenced parent columns by
  index off `oldRow`/`newRow` is consistent.
- **The cascade re-enters the full write path.** `executeForeignKeyActionsAndLens`'
  CASCADE/SET-NULL DML runs via `db._execWithinTransaction` — the already-holding-the-mutex
  variant — so it nests inside the source write's statement savepoint, fires `C`'s own
  constraints + watches + any nested cascade, and (if `C` is itself an MV source) re-drives
  maintenance. This is the "issue against the view re-enters the write path" precedent the
  lens walker established, applied to an ordinary child table.
- **RESTRICT attribution + failure.** A surviving RESTRICT child throws a CONSTRAINT
  `QuereusError` naming `M`; it propagates up through `maintainRowTime` → the DML executor →
  the statement, failing and rolling back the **source write**, attributed to the maintained
  table. Exactly the triage requirement.

### Ordering within `maintainRowTime`

Place the parent-side enforcement **after** `validateDerivedChanges` and **before** the
`if (!this.rowTimeBySource.has(backingBase)) continue;` leaf fast-path / MV-over-MV cascade
loop — so it runs whether or not `M` has MV consumers, and so referential actions fire after
`M`'s own row image is validated, matching the DML executor's per-change order
(capture → MV maintenance → FK actions) that external-changes documents.

`flushDeferredRebuilds` has no MV-over-MV leaf-skip in the same shape; place the call right
after that site's `validateDerivedChanges`, before the backing-base cascade loop.

### Gate / cost

Beyond the `foreign_keys` pragma early-return, fire unconditionally per delete/update change
— the engine's own `O(catalog)` scan for referencing FKs is the **same** cost an ordinary
`delete from M` pays, so this is parity, not a new tax, and the pragma-off path stays free.
A precomputed "tables referencing `M`" reverse-index (kept current by the schema-change
subscription) is a worthwhile **future** optimization but is out of scope here — see the
backlog note below. Do **not** gate on `plan.derivedRowValidator` (that gate is child-side:
constraints declared *on* `M`; an inbound FK lives on `C` and leaves `M`'s plan untouched).

## Edge cases & interactions

- **op gating** — inserts skip (no parent-side action); only `delete` / `update` enforce.
  For `update`, the engine already short-circuits when no FK-referenced parent column moved
  (`sqlValuesEqual`), so a value-preserving / non-key maintenance update is a no-op.
- **MATCH SIMPLE** — a NULL old referenced value participates in no FK match; the engine
  already skips it. Confirm a maintenance delete of an `M` row whose referenced column is
  NULL fires no spurious RESTRICT/cascade.
- **Equal-image maintenance echo** — `applyInverseProjection` suppresses a value-identical
  UPDATE before any backing op, so `backingChanges` is empty and enforcement never runs.
  Confirm no enforcement on a no-op maintenance update.
- **Deferred full-rebuild timing** — a `'full-rebuild'` `M`'s deletes/key-updates only
  materialize in the `applyFullRebuild` diff at end-of-statement flush. Enforcement at the
  `flushDeferredRebuilds` site must run inside the statement-atomicity savepoint (it does —
  the flush is called before the savepoint release) so a RESTRICT failure or a cascade error
  unwinds the whole statement. Test a full-rebuild `M` parent with both a RESTRICT child
  (statement fails) and a CASCADE child (children removed at flush).
- **MV-over-MV cascade vs. parent-side cascade are orthogonal subtrees** — `M`'s MV
  consumers (`rowTimeBySource[backingBase]`) maintain off `M`'s backing changes; `M`'s
  ordinary FK children get referential actions. Both fire on the same `backingChanges`; each
  MV level enforces *its own* table-as-parent during its own `maintainRowTime` recursion, so
  there is no double-fire. Test an MV-over-MV chain where an intermediate backing is also an
  FK parent.
- **Cascade child write re-triggering maintenance** — if child `C` is itself a source of
  another MV, the cascade `delete from C` re-drives maintenance via the nested DML statement
  (its own per-statement savepoint, backing cache, and deferred set). Verify convergence and
  atomicity.
- **Feedback loop `M`(parent of `C`) where `C` is a source of `M`'s body** — a maintenance
  delete of `M` cascades a delete to `C`, which (as an `M` source) re-drives `M`'s
  maintenance. Data-converging (each pass removes rows); the engine's `visited`-set cycle
  detection and `assertCascadeDepth` / `assertFlushRounds` backstops must terminate it
  rather than overflow. Add a test that exercises this and asserts a clean terminal state
  (not an internal cycle error for the legitimate converging case; the backstop fires only
  on a structural impossibility).
- **`foreign_keys` pragma off** — whole path is a single boolean check; no scan, no enforce.
- **Both child and parent** — `M` may declare its own FKs (child-side `derivedRowValidator`)
  *and* be referenced by `C` (parent-side, this ticket). The two hooks coexist independently
  on the same `backingChanges`; confirm an `M` that is both validates its new image AND
  enforces referential actions on its removed/old image.
- **External-changes parity** — `database-external-changes.ts` already runs the identical
  two engine calls (op-gated, `lensRouted = false`, RESTRICT post-application). Keep the
  maintenance call shape byte-for-byte consistent with it so the two non-executor callers
  cannot drift; if a shared private helper reads cleanly, factoring one is welcome but not
  required (the engine is the shared kernel — the call site is thin).
- **SET DEFAULT** — inherits the engine's existing SET DEFAULT coverage and its documented
  rowid-chained-backend caveat (no regression introduced here; just exercise one SET DEFAULT
  child to confirm the maintenance entry point reaches it).

## Tests (TDD targets)

Prefer a runtime TS spec (the FK paths need `pragma foreign_keys = true` and multi-statement
setup), modeled on `test/runtime/fk-restrict-runtime.spec.ts` and the maintained-table specs.
Suggested file: `packages/quereus/test/runtime/maintained-parent-fk.spec.ts`.

Core cases (each: declare `M` as a maintained view, an ordinary `C` with an FK referencing
`M`, seed rows, then drive a SOURCE write that makes maintenance delete/key-update the
referenced `M` row):

- **RESTRICT blocks** — `C ... on delete restrict`; a source write that would delete the
  referenced `M` row throws CONSTRAINT (message names `M`) and rolls back the source write
  (source table unchanged, `C` unchanged, `M` unchanged).
- **CASCADE delete** — `C ... on delete cascade`; the source write succeeds and the matching
  `C` rows are gone.
- **SET NULL** — `C ... on delete set null`; the `C` FK column is nulled.
- **Key-update / ON UPDATE CASCADE** — a source write that moves `M`'s referenced column
  cascades the new value into `C`.
- **Full-rebuild arm** — same matrix but with an `M` body that routes to the full-rebuild
  floor, asserting enforcement fires at the flush boundary (RESTRICT still fails the
  statement; CASCADE still removes children).
- **MV-over-MV intermediate parent** — a 2-level chain where the middle backing is an FK
  parent; a root source write that ripples a delete through the chain enforces at the middle.
- **Converging feedback loop** (`C` is an `M` source) — terminates cleanly.
- **Negative / no-op** — `foreign_keys` off ⇒ no enforcement; NULL referenced value ⇒ no
  action; equal-image maintenance update ⇒ no action.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mp.log; tail -n 80 /tmp/mp.log`
and the lint script before handoff.

## Docs

- `docs/materialized-views.md` — the maintenance "facets" / external-ingestion section
  enumerates capture, MV maintenance, and (for external changes) FK actions; document that
  steady-state maintenance now also fires **parent-side** referential actions on `M`'s own
  backing delete/key-update, and the RESTRICT-fails-the-source-write attribution.
- `docs/incremental-maintenance.md` — note the parent-side enforcement in the write-through
  ordering.

## TODO

- Add `enforceParentSideReferentialActions(plan, backingChanges)` to `MaterializedViewManager`
  (database-materialized-views.ts), importing the two engine functions from
  `runtime/foreign-key-actions.js`. Mirror `validateDerivedChanges`' `this.ctx as unknown as
  Database` cast and `getTable(plan.backingSchema, plan.backingTableName)` parent resolution.
- Call it at both backing-write sites in `maintainRowTime` (after `validateDerivedChanges`,
  before the leaf/cascade) and `flushDeferredRebuilds` (after `validateDerivedChanges`).
- Op-gate (`delete` / `update` only), `lensRouted = false`, RESTRICT-then-actions order,
  `foreign_keys` early-return.
- Write `test/runtime/maintained-parent-fk.spec.ts` covering the matrix above (write the
  RESTRICT-blocks and CASCADE-delete cases first; watch them fail pre-change).
- Update `docs/materialized-views.md` and `docs/incremental-maintenance.md`.
- Park the precomputed inbound-FK reverse-index optimization (see below) in `backlog/`.
