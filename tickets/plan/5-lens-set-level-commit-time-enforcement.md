description: Live per-write enforcement of the lens prover's `enforced-set-level{mode:'commit-time'}` obligation — a logical `unique`/primary-key with no basis covering structure. Today these are classified but NOT enforced: a duplicate inserted through the lens is silently accepted. Design + build a detection-only O(n) commit-time scan that fires on each mutation through the lens. This is the second enforcement class after row-local (which shipped in `lens-constraint-enforcement-wiring`).
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/lens.md
----

## Context

The lens layer reaches write-soundness by consuming the prover's per-constraint
`ConstraintObligation`s (`schema/lens-prover.ts`) on each write. The **row-local
check** class shipped in `lens-constraint-enforcement-wiring` (see
`planner/mutation/lens-enforcement.ts` + the `extraConstraints` seam on the
insert/update builders). This ticket is the **set-level commit-time** class.

A logical `unique` / primary key that the body does not intrinsically prove and
that has **no basis covering structure** is classified by the prover as:

```
{ kind: 'enforced-set-level', mode: 'commit-time' }
```

(see `classifyKeyConstraint` in `lens-prover.ts`; the prover already records
`obligation.mode === 'commit-time'` and emits the `lens.no-backing-index`
advisory). It is currently **classified but not enforced** — a write through the
lens that introduces a duplicate logical key is accepted. The prover's spec test
`enforced-set-level commit-time` covers classification; there is no enforcement.

## Requirements

- A mutation through a lens-backed logical table whose obligations include an
  `enforced-set-level{mode:'commit-time'}` key must be **rejected** at commit when
  it would introduce a duplicate of that logical key (detection-only — ABORT).
- Conflict resolution (`insert or replace` / `or ignore`) is **out of scope** for
  the commit-time class: it requires a covering structure (the row-time class,
  the sibling ticket). A commit-time set-level key under `or replace`/`or ignore`
  must be **rejected** with a clear diagnostic (the prover advisory already states
  "row-time conflict resolution requires a covering structure").
- Zero behavior change for: tables with no set-level obligation, plain views/MVs
  (no lens slot), and read-only logical tables (their set-level enforcement is moot).
- Enforcement must compose with the already-shipped row-local checks on the same write.

## Design notes (from the implement/review handoff — verify during planning)

The intended mechanism is an **assertion-style O(n) scan** piggybacking the
existing commit-time machinery in `core/database-assertions.ts`
(`AssertionEvaluator` + `DeltaExecutor`). The detection predicate is "no two
logical rows share the key" evaluated against the post-mutation relation.

The **main cost / risk** is lifecycle, not the scan: today assertions originate
only from `create assertion` and live in the schema manager's assertion list.
This class needs a **synthetic** commit-time duplicate-detection check that is:
  - registered at lens deploy (the natural site is `schema/lens-compiler.ts`,
    right after `proveLens`, where `obligations` are committed to the slot), and
  - torn down on re-deploy / detach (so a re-`apply schema` does not leak or
    double-register).

Planning must decide: where the synthetic assertion lives (a new slot-scoped
collection vs the global assertion list), how it keys to the logical table and
its basis relation, how it expresses the logical key in basis terms (reuse the
`logicalToBasisColumnMap` rewrite already in `lens-enforcement.ts` — consider
factoring the shared helper noted in the review), and how it interacts with the
`DeltaExecutor` delta for the statement.

## Scope boundary

Detection-only. Row-time enforcement via a covering structure (which unlocks
conflict resolution) is `lens-set-level-rowtime-enforcement` (the sibling, which
takes this ticket as a prereq). FK enforcement is `lens-fk-enforcement-wiring`.
