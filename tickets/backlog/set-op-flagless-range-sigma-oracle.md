description: Harden the flag-less set-op write branch oracle (`set-op-flagless-predicate-honest-writes`) so a leg discriminating by a non-`=` (range) σ on a *projected* column is visible to the consistency check. Today the oracle feeds the leg's *planned physical* `constantBindings`/`domainConstraints` plus synthesized literal-discriminator bindings; a `=`-σ on a projected column forwards as a constant binding, but a RANGE σ (`where x < 5`) on a projected column does NOT, so the leg is included on `sat` even when the mutation predicate provably excludes it. For DELETE/UPDATE this is harmless (the member-exists correlation self-restricts the no-op leg); for INSERT it can over-insert a *phantom base row* into a leg the row does not actually belong to (it is invisible through the view's σ but physically present in the base table).
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: medium
----

## Problem

`legConsistency` (set-op.ts) decides whether an INSERT row / DELETE-UPDATE predicate is
consistent with a leg via `checkSatisfiability(conjuncts, leg.domains, leg.bindings, …)`.
`leg.bindings` = the leg's planned `physical.constantBindings` (which captures a `=`-σ on a
projected column, e.g. `where color='red'` over a `color`-projecting leg) ++ synthesized
literal-discriminator bindings. A **range** σ on a projected column (`where x < 5`) is not a
constant binding and is not forwarded, so the oracle never sees it.

### Consequence

- DELETE / data-UPDATE: honest over-inclusion — the leg is fanned to, but the frozen-capture
  member-exists correlation only matches rows actually resident in the leg, so the no-op leg
  self-corrects. Sound.
- INSERT: the row is routed into the leg even when its supplied value provably violates the
  leg's range σ. The base insert lands a row the view's σ will hide on read-back, but the row
  is physically present in the base table — a phantom row / over-insert.

This only triggers when a leg is distinguished by a range σ on a *projected* column with no
literal discriminator excluding the row (a discriminated design routes precisely). It is a
documented v1 limitation (docs/view-updateability.md § Set Operations), not a regression.

## Desired behavior

Feed the leg's range σ on projected columns into the oracle so a provably-out-of-range INSERT
row skips the leg (no phantom base row). Candidate approaches:

- Forward the leg's raw σ conjuncts that reference projected columns, remapped from base
  attribute → leg output column index, as additional `checkSatisfiability` conjuncts (the
  original ticket's "feed the leg σ conjuncts" wording — needs the base→output attribute remap
  the implementer judged heavier than Option B's planned-physical approach).
- Or surface a projected-column range σ as a `DomainConstraint` on the leg's output (a narrower
  physical-path enhancement).

Add 93.6 coverage: a two-leg flag-less union distinguished by `where x < 5` / `where x >= 5` on
a projected `x`, asserting an INSERT with an out-of-range value does NOT land a phantom row in
the wrong base table.
