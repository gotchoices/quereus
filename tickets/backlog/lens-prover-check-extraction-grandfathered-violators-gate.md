description: lens-prover consumes CHECK-derived domains without the permitsGrandfatheredCheckViolators capability gate that reference.ts applies — latent unsoundness for plugin modules that grandfather check violators.
difficulty: easy
files:
  - packages/quereus/src/schema/lens-prover.ts                        # enumerableDomain(getCheckExtraction(...)) call sites (~1014, ~1086)
  - packages/quereus/src/planner/nodes/reference.ts                   # the existing consumer-side capability gate to mirror (~130-142)
  - packages/quereus/src/vtab/capabilities.ts                         # permitsGrandfatheredCheckViolators contract
  - packages/quereus/test/optimizer/check-fold-gated-by-capability.spec.ts  # existing gate pin (reference.ts path only)
----

# lens-prover CHECK-domain use bypasses the grandfathered-violators capability gate

`TableReferenceNode.computePhysical` (reference.ts) suppresses all
CHECK-derived contributions when the owning vtab module declares
`permitsGrandfatheredCheckViolators: true` — under that contract,
`ALTER TABLE … ADD CHECK` succeeds against non-conforming rows and
grandfathers the violators, so a declared CHECK is not a universal invariant
over the current row set.

`lens-prover.ts` does not apply that gate: `enumerableDomain(
getCheckExtraction(ctx.table), li)` and `enumerableDomain(
getCheckExtraction(basis), bi)` consume check-derived enum domains for
coverage/completeness proofs regardless of the basis module's capabilities.
A lens proof built on a domain that grandfathered rows violate could certify
a mapper that silently drops or misroutes those rows.

**Severity / reachability:** latent today. No shipped module declares the
capability (only a test double in check-fold-gated-by-capability.spec.ts
does); third-party plugin modules could. Pre-existing — not introduced by
the row-invariant gate (check-extraction-rowop-mask-transition-checks),
which screens per-check properties (mask, deferral, `old.` refs), not
per-module capabilities.

## Expected behavior

A lens whose basis table belongs to a module declaring
`permitsGrandfatheredCheckViolators` must not use that table's CHECK-derived
domains in prover reasoning (fail the proof or fall back to capability-free
reasoning, matching reference.ts's conservative direction).

Open design question: whether the gate belongs at each consumer (mirror
reference.ts inside lens-prover) or centrally (e.g. a capability-aware
variant of `getCheckExtraction` so future consumers cannot forget it). The
central option also future-proofs the assertion-hoist path, though
assertions are independent of table CHECK grandfathering.
