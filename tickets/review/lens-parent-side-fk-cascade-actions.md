description: Review the runtime cascade walker that propagates CASCADE / SET NULL / SET DEFAULT parent-side actions for a *logical* foreign key through the lens. A lens-backed logical parent delete/update now cascades (deletes / nulls / defaults) the referencing logical child rows by issuing the propagating DML against the logical child *view* (so each cascade re-enters the lens write path), composing with the physical FK-action walker via structural elision. Shipped alongside a behavior-preserving extraction of shared catalog-only FK discovery into `schema/lens-fk-discovery.ts`.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The action complement to the parent-side RESTRICT/NO-ACTION detection
(`lens-parent-side-fk-enforcement`). A logical FK lives only on the child slot's
`enforced-fk` obligation (on no basis table), so the physical
`executeForeignKeyActions` (which scans declared `TableSchema.foreignKeys`) never sees
it. Before this ticket, deleting/updating a lens-backed logical parent silently
propagated no action for a non-RESTRICT logical FK.

Realized as a **runtime cascade walker** — the logical dual of
`executeForeignKeyActions` — that issues the propagating DML against the logical child
*view* (`x.child`), not the basis child (`y.child`). Issuing against the view re-plans
through the lens write substrate, so each cascade re-enters the full lens write path
(the child's own row-local checks, child-side FK checks, set-level checks, **and nested
logical cascades** all fire), exactly as a user-issued `delete from x.child` would.

### Three phases

1. **Behavior-preserving extraction** (`schema/lens-fk-discovery.ts`, new). Moved the
   catalog-only helpers out of `planner/mutation/lens-enforcement.ts` so the runtime
   walker and the planner collector share them without a layering violation (both sit
   above `schema/`): `logicalToBasisColumnMap`, `resolveLogicalReferencedColumns`,
   `pairKey`, `mappedFkBasisPairs`, `matchingBasisFks`. Added `findLogicalParentFkRefs`
   (cross-slot discovery: every logical FK referencing a given parent slot, with the
   child/parent column names + count-mismatch guard resolved) and
   `basisChildCarriesEquivalentFk` (the cascade elision predicate — the redundancy
   detector's structural core *without* the non-row-reducing projection gate).
   `lens-enforcement.ts` now imports these; `collectLensParentSideForeignKeyConstraints`
   was refactored to consume `findLogicalParentFkRefs`. `isNonRowReducingProjection` and
   `basisFksSubsuming` stayed put (the projection gate is RESTRICT-side only).

2. **Runtime cascade walker** (`runtime/foreign-key-actions.ts`).
   `executeLensForeignKeyActions(db, basisParentTable, op, oldRow, newRow)`:
   gate on `foreign_keys`; reverse-map `basisParentTable` → logical parent slot(s) it
   backs (via `resolveSlotBasisSource`); discover referencing logical FKs; filter to
   `cascade`/`setNull`/`setDefault`; **elide** when the basis child already carries a
   structurally-equivalent FK (the physical walker propagates over the basis instead);
   apply MATCH SIMPLE + the UPDATE referenced-column-change short-circuit (reading
   OLD/NEW values off the basis row by logical→basis→index mapping); issue the
   logical-child DML (`issueLensFkAction`, the dual of `executeSingleFKAction`) — params
   bound, never inlined; SET DEFAULT uses the **logical** child column's `defaultValue`.

3. **DML wiring** (`runtime/emit/dml-executor.ts`). A combined wrapper
   `executeForeignKeyActionsAndLens` (physical then lens) replaced all 6 bare
   `executeForeignKeyActions` call sites (primary delete/update in
   `processDeleteRow`/`processUpdateRow`, the UPSERT-update path, the two REPLACE
   `replacedRow` delete paths, and `processEvictions`) so the physical + lens sites
   cannot drift.

## Validation performed

- `yarn workspace @quereus/quereus run build` → tsc exit 0.
- `yarn eslint 'src/**/*.ts' 'test/**/*.ts'` → exit 0.
- Full suite (`node test-runner.mjs`) → **4312 passing, 9 pending, 0 failing**.
- The 74 pre-existing `lens-enforcement.spec.ts` tests stay green after the Phase-1
  refactor (confirms behavior-preserving extraction).
- 15 new tests added (13 behavioral + mixed-cycle + 2 unit) — all green.

## Test coverage (the floor — reviewer should treat as a starting point)

In `test/lens-enforcement.spec.ts`, over the canonical `deployCascadeLens` shape (basis
carries **no** FK; the action lives only on the logical FK), `pragma foreign_keys` on:

- CASCADE DELETE (children gone, basis reflects it, unreferenced parent untouched).
- CASCADE UPDATE (child FK column rewritten to new key, child row preserved).
- SET NULL (delete) + SET NULL update-analogue (child FK nulled, row preserved).
- SET DEFAULT (child FK set to logical `default 0`; seeds a parent id=0 so the
  re-defaulted child still satisfies its deferred child-side FK at commit).
- MATCH SIMPLE (composite FK with a NULL referenced component ⇒ no cascade).
- UPDATE short-circuit (non-referenced parent column change ⇒ child untouched).
- Transitive parent → child → grandchild (all cascade-delete).
- Re-enters the lens write path (a cascade-update violating the logical child's own
  row-local `check` ABORTs — proves the cascade rides the lens path, not a basis-direct
  write).
- Elision / no double-cascade (basis also carries the equivalent CASCADE FK ⇒ removed
  exactly once; asserts `basisChildCarriesEquivalentFk` returns true).
- Pragma gate (`foreign_keys = false` ⇒ child orphaned, not deleted).
- Multi-source parent (delete/update fires no lens cascade and does not throw).
- Mixed logical/basis FK cycle (terminates by data exhaustion, no double-delete).
- Unit: `findLogicalParentFkRefs` returns the expected child ref / `[]`;
  `basisChildCarriesEquivalentFk` fires iff an equivalent basis FK exists.

## Known gaps / things to scrutinize (honest handoff)

- **Wired-but-untested cascade sites.** The lens cascade is wired into all 6 DML call
  sites, but the tests exercise only the **primary** delete/update paths. The
  UPSERT-update (`processInsertRow` line ~501), the two REPLACE `replacedRow` delete
  paths (~540, ~706), and `processEvictions` (~598) fire the lens cascade but have **no
  dedicated test**. A reviewer should sanity-check that a REPLACE/eviction that displaces
  a lens-backed logical parent cascades correctly (and that the eviction/move ordering
  the physical walker already relies on is not disturbed by the added lens cascade).
- **Composite CASCADE not exercised for the mutating path.** The composite FK appears
  only in the MATCH-SIMPLE (null) test; a multi-column CASCADE DELETE/UPDATE issuing the
  multi-column WHERE/SET is not directly tested (the single-column code path is, and the
  composite WHERE/SET is built by the same `.map(...).join(...)`).
- **SET DEFAULT with a NULL default** (no `defaultValue` ⇒ `= null`) is handled the same
  as the physical walker but not tested through the lens.
- **Divergent basis-vs-lens action** is a documented limitation, **not** solved here:
  the elision is action-agnostic, so when the basis child carries an equivalent FK with a
  *different* parent-side action (e.g. basis `on delete cascade` under a logical
  `on delete set null`, or a basis RESTRICT that aborts the parent before any logical
  cascade runs), the **basis** action governs. Filed as
  `tickets/backlog/lens-parent-side-fk-divergent-basis-action.md` (already on disk,
  consistent with this implementation). Same hard family as the in-flight
  `lens-parent-side-fk-cascade-basis-restrict-lens-not-enforced`.
- **Per-row scan cost.** `executeLensForeignKeyActions` scans every schema's lens slots
  on every basis delete/update (early-returns cheaply when `foreign_keys` is off or no
  slot is backed by the table). Non-lens DBs pay one near-empty scan; a lens DB with many
  slots pays O(slots × FKs) per row — the same order as the RESTRICT collector. Accept
  for v1; flag if a hot path regresses.
- **Two logical parents over one basis table.** If two logical views share a basis parent
  table, the reverse-map fires both their cascades on that basis op. Believed correct
  (both logical parents lose the row) but untested and worth a second opinion.
- **Cycle termination relies on data exhaustion**, not a `visited` set (matching the
  physical SQL-issuing path — `executeSingleFKAction`'s `_execWithinTransaction` cascades
  also terminate this way). The mixed-cycle test pins one terminating shape; a reviewer
  may want to confirm a pathological non-terminating-by-data shape cannot arise (it
  shouldn't — every cascade strictly removes/re-keys rows the next level matches on).

## Pre-existing failures

None encountered. The full suite was green at HEAD-with-this-change; no
`.pre-existing-error.md` was written.
