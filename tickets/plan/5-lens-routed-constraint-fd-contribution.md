description: Surface a lens-routed/declared logical key as a functional dependency to the optimizer's FD framework on the routed-constraint path. A `proved`/`vacuous` key, and a non-proved but *enforced* set-level key, should contribute their key/FD to the optimizer even when the compiled body does not intrinsically prove it. Today only body-intrinsic FDs flow (the logical table is an inlined `ViewSchema`); the *declared* logical key does not surface as an FD when the body alone can't prove it. This is the "pending half" `docs/optimizer.md` notes.
prereq:
files: packages/quereus/src/planner/analysis/, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens-compiler.ts, docs/optimizer.md, docs/lens.md
----

## Context

The lens prover classifies each logical key as `proved`, `enforced-set-level`, or
`vacuous` (`schema/lens-prover.ts`). Because a logical table is registered as an
**inlined `ViewSchema`**, FDs *intrinsic to the body* already flow to the
optimizer's FD framework via the normal view-inlining path. What does **not** flow
is the **declared logical key** when the body alone does not prove it: a key that
is only true because the lens *enforces* it (set-level), or a `proved`/`vacuous`
key whose guarantee the optimizer should be able to rely on as an FD.

`docs/optimizer.md` notes this as the pending half of the constraint-attachment
work; the `lens-constraint-enforcement-wiring` review explicitly deferred it.

## Requirements

- A logical key the lens **guarantees** (obligation `proved` or `vacuous`, and a
  non-proved but actively-*enforced* `enforced-set-level` key) should contribute
  its key / functional dependency to the optimizer's FD framework on the
  routed-constraint path, so downstream rules (join elimination, order-by pruning,
  distinct elimination, etc.) can exploit it.
- Soundness gate: an FD must be contributed **only** when the lens actually
  guarantees it. A `commit-time` set-level key that is enforced detection-only
  still guarantees post-commit uniqueness — confirm during planning whether that
  is a sound FD for the optimizer to assume mid-statement (Halloween / read-own-
  writes interactions), and degrade conservatively if not.
- No FD contributed for a key the lens does not enforce or prove.

## Design notes (from the implement/review handoff — verify during planning)

The riskiest part (per the original `4-lens-constraint-enforcement-wiring` ticket)
is the view-write/mutation path; trace it first. The logical table is an inlined
`ViewSchema`, so body-intrinsic FDs already flow — this ticket is specifically the
*declared logical* key surfacing as an FD even when the body doesn't prove it.
Likely touch points: the FD-derivation in `planner/analysis/` and where the lens
slot's obligations could be consulted during inlining/optimization.

## Scope boundary

Optimizer FD-contribution only — the enforcement classes (row-local shipped;
set-level / FK in sibling tickets) are orthogonal. This ticket can land
independently of the FK / set-level *enforcement* tickets, but a set-level FD is
only sound once that key is actually enforced — sequence accordingly if planning
finds a dependency.
