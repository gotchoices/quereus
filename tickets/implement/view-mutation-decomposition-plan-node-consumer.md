description: Phase B3 of the derived-backward-walk. Converge the decomposition fan-out (`decomposition.ts`) onto the same plan-node backward-walk consumer the multi-source path uses after B2, where it currently leans on AST-level analysis (the `buildViewColMap` projection-AST map, the `collectColumnQualifiers` AST scan in `anchorPredicate`, the AST `stripAnchorQualifier` / `rewriteAssignedValue`). Goal: single-source / multi-source / decomposition share ONE backward-walk consumer rather than three. Acceptance gate: Family C of the View Round-Trip Law harness stays green with behavioral parity.
prereq: view-mutation-retire-ast-roundtrip
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/view-complement.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md

## Context (Phases A + B1 + B2 have landed)

Phase A: shared `scope-transform.ts`. B1: multi-source consumes the full `UpdateSite`.
B2: the multi-source update/delete substrate consumes the planned body node directly,
retiring the AST round-trip. This ticket extends that consumption to the decomposition
fan-out so all three backward paths share one consumer.

## The debt this closes

`decomposition.ts` derives its backward decisions from AST analysis rather than the
threaded plan-node lineage:
- `buildViewColMap(view)` reads the synthesized get-body's projection AST (`<expr> as
  <logicalColumn>`) to build logical-col → base-expr — duplicating what `updateLineage`
  threads on the planned body.
- `anchorPredicate` rewrites the user WHERE via the AST `substituteViewColumns` then scans
  qualifiers with `collectColumnQualifiers` (a hand-rolled AST walk) to enforce
  anchor-only references.
- `stripAnchorQualifier` / `rewriteAssignedValue` are AST-level rewrites.

After B2 the multi-source path has a plan-node consumer for "bind each output column to
its owning base + reconstruct the per-side identifying predicate". The decomposition
fan-out should reuse that consumer (generalized from two FK-ordered sides to the n-way,
anchor-first/anchor-last member fan-out with optional / EAV members) instead of its
parallel AST analysis.

## Scope notes

- The decomposition INSERT envelope (`analyzeDecompositionInsert` +
  `buildDecompositionInsert`) is a separate, plan-level surface already (the shared-
  surrogate envelope) — converge only the *backward decision* derivation (column→member
  routing, identifying predicate, anchor-only gate) onto the plan-node consumer, not the
  envelope materialization.
- Preserve the anchor-last DELETE/UPDATE ordering invariant (each non-anchor member's
  identifying set reads the still-intact anchor), the `unsupported-decomposition-*`
  deferral diagnostics, and the EAV / optional-member handling exactly.
- Keep `ViewMutationNode` + base-table builder reuse for the writes.

## Acceptance criteria

- `decomposition.ts` derives its backward decisions from the threaded plan-node
  `updateLineage` / `viewComplement` (shared with the multi-source consumer), not a
  parallel AST analysis (`buildViewColMap` / `collectColumnQualifiers` retired or reduced
  to a thin shim over the shared consumer).
- `yarn workspace @quereus/quereus test` green, including Family C (`describe('decomposition
  fan-out')`) and the lens put-fanout suites — behavioral parity with the AST path.
- `yarn workspace @quereus/quereus run lint` clean.
- `docs/view-updateability.md` § Decomposition put fan-out + `docs/lens.md` § The Default
  Mapper note the shared backward-walk consumer.

## TODO
- [ ] Generalize the B2 plan-node consumer (column→base routing + identifying predicate) to the n-way member fan-out.
- [ ] Re-express decomposition column routing / anchor-only predicate gate / qualifier strip on the shared consumer; retire the parallel AST analysis.
- [ ] Prove Family C + lens put-fanout parity; lint clean.
- [ ] Update `docs/view-updateability.md` + `docs/lens.md`.
