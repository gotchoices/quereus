description: Review the live per-write lens constraint enforcement. The implement pass delivered the **row-local CHECK** enforcement class end-to-end (a logical `check` classified `enforced-row-local` now fires on every insert/update through the lens, rewritten from logical→basis column terms and merged into the basis write's per-row check pipeline) plus the `lens.boundary.attached` marker. The set-level (row-time + commit-time), foreign-key, and optimizer FD-contribution enforcement classes were **scoped out** and are flagged below as major follow-ups — the reviewer should spawn fix/plan tickets for them.
prereq: lens-prover-and-attachment
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/planner/mutation/single-source.ts
----

## TL;DR for the reviewer

This ticket is the second half of the lens layer: turning the prover's *classified*
`ConstraintObligation`s into *live* per-write enforcement. The original ticket asked
for **all** obligation classes (row-local, set-level row-time, set-level commit-time,
FK, FD-contribution) in one pass. The implement stage delivered **one class fully and
honestly** — `enforced-row-local` — and deliberately deferred the rest rather than ship
four half-wired subsystems. Treat the delivered slice as production-ready-pending-review
and the deferred classes as **major findings to spawn follow-up tickets for** (design
notes provided below so they're ready to action).

Important context the original ticket predates: the view-mutation path was refactored
from an AST `rewriteView{Insert,Update,Delete}` (the ticket's `view-mutation.ts`) into a
**propagate substrate** — `building/view-mutation-builder.ts` → `mutation/propagate.ts`
→ `mutation/single-source.ts`. The enforcement wiring rides that substrate, not the
retired rewrite. The ticket's file list is stale on this point; the `files:` header above
is corrected.

## What landed (verify this)

**Row-local CHECK enforcement at the lens write boundary.** A logical `check` over
non-computed (reconstructible) columns — the prover's `enforced-row-local` obligation —
now fires on every insert/update through a logical table, even when the basis table
carries no such check.

Mechanism (trace in this order):
1. `planner/mutation/lens-enforcement.ts` (**new**) — `collectLensRowLocalConstraints(slot)`
   reads `slot.obligations`, keeps the `enforced-row-local` CHECKs, and rewrites each from
   logical→basis column terms using the slot's reconstructible projection
   (`compiledBody.columns` — mirrors the prover's `mappedBasisColumn`). Each result is a
   `RowConstraintSchema` (operations INSERT|UPDATE) tagged `quereus.lens.boundary.attached`
   (the marker the ticket asked for — `LENS_BOUNDARY_ATTACHED_TAG`).
2. `planner/building/view-mutation-builder.ts` — after `propagate`, looks up the lens slot
   the same way `single-source.ts` resolves the read-only gate (`getSchema(view.schemaName)
   ?.getLensSlot(view.name)` — only a logical schema has one, so plain views/MVs are
   unaffected), collects the constraints (skipped for DELETE — no NEW row), and threads
   them into each base op.
3. `building/constraint-builder.ts` `buildConstraintChecks` gained an optional
   `additionalConstraints` param; `building/insert.ts` / `building/update.ts` gained an
   optional `extraConstraints` param that forwards to it. The extra checks resolve against
   the **basis** table's columns (since they're already rewritten to basis terms) and ride
   the existing per-row `ConstraintCheckNode` — so determinism validation, conflict
   resolution, OLD/NEW scope, etc. are all reused verbatim.

### Use cases / validation (the new spec is the floor, not the ceiling)

`test/lens-enforcement.spec.ts` (5 tests, all green) covers:
- a logical `check (val >= 0)` blocks a violating insert *and* update through `x.t` while a
  direct violating insert into the basis `y.t` still succeeds (proves enforcement is at the
  lens, not the basis, and is not retroactive);
- the same under a **rename override** (`select id, speed as maxSpeed`), asserting the
  CHECK was rewritten to the basis column (`speed`, not `maxSpeed`) — the logical→basis
  mapping is the load-bearing, error-prone part;
- the `quereus.lens.boundary.attached` marker + `lens:<name>` naming on routed constraints;
- a check-free / non-lens write routes **zero** extra constraints (no overhead, no
  behavior change for plain tables/views);
- DELETE does not spuriously enforce a row-local check.

**Reviewer: things worth probing that the floor does not cover** —
- a CHECK referencing **multiple** logical columns, and a column whose logical name equals a
  *different* basis column under an override (aliasing correctness);
- a CHECK that references a column **not** in the projection (should have been blocked at
  deploy by `lens.unrealizable-constraint`; confirm the rewrite degrades safely if it ever
  reaches here — currently it strips qualifiers and leaves the name as-is);
- `OR IGNORE` / `OR REPLACE` interaction with a lens row-local check (the synthetic
  constraint inherits statement-level conflict handling via the basis `ConstraintCheckNode`;
  confirm this is the intended semantic);
- a CHECK over a column that is **not null in logical but nullable in basis** — NOT NULL is
  **not** an obligation (see gap #1 below), so it is not enforced here;
- multi-statement / RETURNING / upsert paths through the lens.

## Known gaps — MAJOR, spawn follow-up tickets

These are intentional scope cuts, not oversights. Each is a distinct subsystem; bundling
them risked shipping four half-wired paths. Recommend the reviewer file one fix/plan ticket
each (slugs suggested).

1. **Set-level commit-time enforcement** (`lens-set-level-commit-time-enforcement`).
   `enforced-set-level{mode:'commit-time'}` (a logical `unique`/PK with no basis covering
   structure) is **classified but not enforced** — a duplicate inserted through the lens is
   currently accepted. The ticket's design: an O(n) assertion-style scan piggybacking
   `core/database-assertions.ts` (`AssertionEvaluator` + `DeltaExecutor`), detection-only
   (ABORT works; IGNORE/REPLACE rejected with "row-time conflict resolution requires a
   covering structure"). Implementation note: assertions today come only from
   `CREATE ASSERTION` and live in the schema manager's assertion list; this needs a
   **synthetic** commit-time duplicate-detection check registered at lens deploy and torn
   down on re-deploy/detach. That lifecycle integration is the bulk of the work and the main
   reason it was deferred. The prover already records `obligation.mode === 'commit-time'`;
   the deploy site is `schema/lens-compiler.ts` (right after `proveLens`).

2. **Set-level row-time enforcement + conflict resolution**
   (`lens-set-level-rowtime-enforcement`, prereq the commit-time ticket). For
   `enforced-set-level{mode:'row-time', structure}`, route the existence lookup through the
   basis covering structure (the prover already resolved it via
   `_findRowTimeCoveringStructure`; `findIndexForConstraint` prefers the covering MV).
   This is what unlocks `insert or replace` / `or ignore` / `abort`. Look at
   `vtab/memory/layer/manager.ts` and the MV "enforcement through a covering MV" path
   (docs/materialized-views.md) — that machinery already exists for physical UNIQUE; the
   work is routing the *logical* obligation through it.

3. **Foreign-key commit-time enforcement** (`lens-fk-enforcement-wiring`). `enforced-fk` is
   classified but not enforced. Cross-relation existence at commit via `DeltaExecutor`
   against the referenced relation (a covering structure on the parent is optional). Note
   `foreign_keys` pragma gating and that the basis tables may already carry the FK (in which
   case the logical FK is redundant — confirm whether to skip or double-enforce).

4. **Optimizer FD-contribution of routed constraints**
   (`lens-routed-constraint-fd-contribution`). A `proved`/`vacuous` key, and a non-proved
   *enforced* set-level key, should contribute their key/FD to the optimizer's FD framework
   on the routed-constraint path (`planner/analysis/`, `docs/optimizer.md` notes this as the
   pending half). The logical table is an inlined `ViewSchema`, so body-intrinsic FDs already
   flow; this gap is specifically the *declared logical* key surfacing as an FD even when the
   body doesn't prove it. Trace the view-write/mutation path first (the riskiest part, per the
   original ticket).

5. **NOT NULL row-local** (minor — fold into ticket #1 or note as accepted). The ticket
   mentions `enforced-row-local (... not null)`, but NOT NULL is **not** in
   `attachedConstraints`/`obligations` (only primaryKey/check/unique/foreignKey are). The
   prover's `checkTypeAndNullability` blocks the unsound deploy case at compile time, so the
   residual runtime gap is narrow: a logical NOT-NULL column over a *nullable* basis column
   *with a total default* would still accept an explicit-NULL write through the lens. Not
   enforced here by design (obligation-driven scope). Decide whether to synthesize a
   `col IS NOT NULL` check for that case.

## Build / test status

- `tsc --noEmit` (quereus): clean.
- `eslint` on all changed/new files: clean.
- Full quereus spec suite: **4150 tests, 0 failures, 9 skipped** (xunit) — includes the 5 new
  enforcement tests. `test/lens-prover.spec.ts` (the prover's classification spec) passes
  **unchanged** — no classification was altered, only consumption.
- `documentation.spec.ts`: 6/6 after the `docs/lens.md` edits (maturity note + implementation
  surface updated to "partially shipped: row-local live; set-level/FK/FD pending").
- Not run: `yarn test:store` (LevelDB path) — out-of-band per agent rules; the change is in
  the planner/builder layer and is storage-agnostic, but a store-path sanity check on lens
  row-local enforcement is a reasonable reviewer ask.

## Design seams worth a reviewer's eye

- The `extraConstraints` seam on the three builders is deliberately generic (a plain
  `RowConstraintSchema[]` in target-column space). It is only ever populated by the lens
  path today; confirm no other caller should use it and that defaulting to `[]` keeps every
  existing call site byte-identical.
- `buildBaseOp` routes the same `extraConstraints` to every base op. For the single-source
  spine there is exactly one base op, so this is unambiguous; multi-source put fan-out (which
  would need per-member routing) is a later phase and is write-rejected upstream — documented
  in the code comment. Verify that assumption still holds (a writable multi-source lens must
  not reach `buildBaseOp` with shared constraints).
- The logical→basis map in `lens-enforcement.ts` duplicates the prover's `mappedBasisColumn`
  logic. Consider whether to factor a shared helper (the prover is in `schema/`, the
  enforcement in `planner/mutation/`; the layering currently keeps them separate on purpose).
