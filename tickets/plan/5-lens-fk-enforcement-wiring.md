description: Live per-write enforcement of the lens prover's `enforced-fk` obligation — a logical foreign key. Today classified but NOT enforced: a write through the lens with a dangling logical FK reference is accepted. Design + build a commit-time cross-relation existence check (via `DeltaExecutor`) against the referenced logical relation, gated by the `foreign_keys` pragma.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/lens.md
----

## Context

Every logical foreign key is classified by the prover as
`{ kind: 'enforced-fk' }` (see `classifyConstraint` in `lens-prover.ts` — FK is
unconditionally this obligation). Classified, not enforced: the prover spec's
`enforced-fk` test covers classification only. A write through the lens that
introduces a dangling reference is currently accepted (unless the basis tables
themselves carry the FK — see below).

## Requirements

- A mutation through a lens-backed logical table with an `enforced-fk` obligation
  must enforce **cross-relation existence at commit**: the referenced logical key
  must exist in the referenced relation. ABORT on violation.
- Gated by the `foreign_keys` pragma (match physical-FK gating semantics).
- Compose with row-local checks and set-level enforcement on the same write.
- No behavior change when no FK obligation is present.

## Design notes (from the implement/review handoff — verify during planning)

Cross-relation existence at commit via `DeltaExecutor` against the referenced
relation (a covering structure on the parent is optional — without one it is an
O(n) scan, with one it can be a lookup). Reuse the commit-time scan substrate the
set-level commit-time ticket establishes if it generalizes.

**Decision the plan must make — redundancy with the basis FK.** The basis tables
may already carry the foreign key (in which case the basis write enforces it and
the logical FK is redundant). Planning must decide whether to:
  - **skip** the logical FK enforcement when the basis already enforces an
    equivalent FK (detect via the basis `TableSchema.foreignKeys`), or
  - **double-enforce** (simpler, slightly redundant cost).
Document the choice and its rationale in the resulting implement ticket.

## Scope boundary

FK only. Row-local / set-level are separate tickets. ON DELETE/UPDATE cascade
actions through the lens are explicitly a later concern unless trivially covered
by the basis FK — call this out in the plan.
