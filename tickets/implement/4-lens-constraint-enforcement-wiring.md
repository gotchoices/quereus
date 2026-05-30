description: Live per-write enforcement of the lens prover's constraint obligations. The prover (`lens-prover-and-attachment`) already classifies every logical constraint into a `ConstraintObligation` on `LensSlot.obligations` and enforces the read-only verdict; this ticket makes the *non-read-only* obligations actually fire on each mutation through the lens — routing row-local checks into the per-row check pipeline, set-level UNIQUE existence into the covering-structure lookup (row-time) or commit-time scan, and FK into the commit-time DeltaExecutor. This is the second half that flips the lens layer from "classified-for-write-soundness at deploy" to "enforced-on-every-write".
prereq: lens-prover-and-attachment
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/src/planner/nodes/constraint-check-node.ts, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database-assertions.ts
effort: xhigh
----

## Why this is separate

`lens-prover-and-attachment` landed the prover that **proves, blocks, classifies, and advises**, plus the read-only mutation gate and the auto-index retirement. It deliberately stopped short of the *live per-write enforcement* of the classified obligations because:

- the view-DML rewrite re-plans against the **basis table by name** (`view-mutation.ts` → `rewriteView{Insert,Update,Delete}`), which **drops the logical context** — so attaching logical-spec checks to that re-planned mutation needs a deliberate threading mechanism, not a one-line hook;
- it spans the DML builders **and** the module boundary (UNIQUE) **and** the commit-time `DeltaExecutor` (FK) — a large, separable body of work that is sounder built and tested on its own than rushed alongside the prover.

The prover's obligation shape (`LensSlot.obligations`, `ConstraintObligation`) is the contract this ticket consumes. **Assume it has landed and is correct** (it is — green at 4031 tests).

## Scope — make each obligation class fire on a write through the lens

The prover already decided *what* each constraint becomes; this ticket makes it *happen*. For a write to a logical table `X.T` (which view-updateability rewrites to a basis write), wire enforcement at the lens-write boundary, keyed off `slot.obligations`:

- **`enforced-row-local`** (scalar `check`, `not null`): inject the logical constraint into the basis write's per-row check pipeline. The investigated insertion point is `buildConstraintChecks` (`constraint-builder.ts`) / the `ConstraintCheckNode` the three DML builders construct — merge the logical CHECK/NOT-NULL (in logical-column space, mapped to the basis row) before the node is built, or wrap the re-planned basis mutation in an additional `ConstraintCheckNode` carrying the logical checks. **Trace the logical→basis column mapping carefully** — the rewrite loses the logical projection, so the mapping must be threaded (e.g. via the lens slot's `compiledBody` projection) rather than re-derived.
- **`enforced-set-level` `row-time`**: route the existence lookup through the basis covering structure (`findIndexForConstraint` already prefers a non-stale row-time covering MV). Surface `insert or replace` / `or ignore` / `abort` conflict resolution.
- **`enforced-set-level` `commit-time`**: O(n) `DeltaExecutor` / assertion-style scan (piggyback `core/database-assertions.ts`; no new commit-phase consumer). **Detection-only**: ABORT works; IGNORE/REPLACE are rejected with "row-time conflict resolution requires a covering structure".
- **`enforced-fk`**: cross-relation existence at commit via `DeltaExecutor` (no kernel change); a covering structure on the referenced relation is optional, used when present.
- **`proved` / `vacuous`**: nothing to enforce (zero runtime cost) — but **contribute the proved key/FD to the optimizer's FD framework** for the routed-constraint path (`docs/optimizer.md` notes this is the pending half). For a *non-proved, enforced* set-level constraint, also contribute its key signal as an additional FD so the optimizer benefits even before a covering structure exists.

## Also in scope

- **`lens.boundary.attached` marker** on the `table.ts` logical-constraint records once routed, so the runtime knows enforcement is alive at the lens.
- **Planner wiring** (`planner/analysis/`): read the routed constraints from the lens slot when planning over a logical-table reference; constraints ride the FD-contribution path. The lens body inlines as a registered `ViewSchema`, so the logical constraint surface should ride the same FD path as any declared constraint — **trace the view-write/mutation path first** (it is the riskiest part).

## Key tests to add (the prover spec is the shape to mirror)

- **Row-local check fires at the lens boundary**: insert/update violating a logical `check` over a non-computed column raises at the lens write, not at commit, even when the basis carries no such check.
- **Set-level commit-time**: logical `unique(email)` with no basis covering MV — insert a duplicate through the lens → commit-time scan errors (assertion-style); ABORT works; IGNORE/REPLACE rejected with the covering-structure message.
- **Set-level row-time**: same with a basis covering MV — duplicate → row-time conflict; IGNORE/REPLACE/ABORT all work.
- **FK**: a logical FK with no matching parent row → commit-time error.
- **End-to-end scenario suite**: deploy a logical schema, exercise inserts/updates/deletes through it with each enforcement class, asserting enforcement happens *at the lens* (not only when the basis happens to carry the constraint).
- Regression floor: the entire existing suite stays green; the prover's classification spec (`test/lens-prover.spec.ts`) must still pass unchanged.

## Out of scope (sibling / backlog)
- Acknowledgment tags, fingerprints, escalation policy, and surfacing the deploy report as `apply schema` result rows → sibling `lens-advisory-acknowledgment` (consumes `DeclaredSchemaManager.getDeployedLensReport`).
- The computed round-trip complement (`proveRoundTrip` swap) → `bx-operator-model-and-roundtrip-laws` + `view-mutation-plan-node-substrate`.
- Multi-source decomposition put fan-out → `lens-multi-source-decomposition` / `lens-multi-source-put-fanout`.
