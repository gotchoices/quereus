description: |
  Hardened the lens decomposition per-op constraint gate against subquery-bearing row-local CHECKs.
  The `writeRowColumns` AST walker under-collected a correlated bare write-row ref appearing only inside
  a subquery, while the prover classifies ANY scalar CHECK over reconstructible columns (subqueries
  included) as `enforced-row-local` — so on a decomposition that under-collection threaded the CHECK onto
  a member op whose target lacked the column → `<col> isn't a column` build crash. Fix:
  `collectLensRowLocalConstraints` now attaches prover-supplied `referencedWriteRowColumns` metadata
  (source CHECK's referenced logical columns mapped to basis columns); `constraintsForOp` prefers it over
  the walk for the row-local class. Row-local only — FK / set-level keep the (correct) walk. Plus a DRY
  consolidation of the duplicated `collectColumnRefNames`. Reviewed, validated, complete.
files:
  - packages/quereus/src/schema/table.ts                              # RowConstraintSchema.referencedWriteRowColumns
  - packages/quereus/src/schema/lens-prover.ts                        # collectColumnRefNames exported
  - packages/quereus/src/schema/lens-compiler.ts                      # local collectColumnRefNames duplicate removed
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # rowLocalReferencedBasisColumns + metadata attach
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # constraintsForOp prefers metadata
  - packages/quereus/test/lens-put-fanout.spec.ts                     # 3 subquery-CHECK regressions + setupSubqueryCheck
  - docs/lens.md                                                      # § Enforcement: per-class write-row-column derivation
----

# Harden lens decomposition constraint-gate against subquery-bearing row-local CHECKs — COMPLETE

## What shipped

The per-op decomposition gate (`constraintsForOp`) now derives a **row-local** CHECK's write-row column
dependency from prover-supplied `referencedWriteRowColumns` metadata (the source CHECK's referenced
logical columns mapped through the slot's logical→basis projection) instead of the `writeRowColumns` AST
walk, which under-collects a correlated bare ref appearing only inside a subquery. FK / set-level classes
leave the metadata undefined and keep the walk (their `NEW.*`/`OLD.*` refs the walker collects
unambiguously). The byte-identical duplicate `collectColumnRefNames` was consolidated into the prover's
exported copy. See the original implement handoff (commit `f95b6081`) for the full design rationale.

## Review findings

Adversarial pass over the implement diff (`git show f95b6081`), read fresh before the handoff summary.

### Verified correct

- **Metadata faithfully mirrors the prover.** `rowLocalReferencedBasisColumns` and the prover's
  `classifyCheckConstraint` both enumerate via the same shared `collectColumnRefNames` and keep only
  refs that are logical columns of the table. The gate-vs-prover "row-local column" notions are now
  provably the same set. The map-vs-logicalColIndex discrepancy (map = reconstructible logical columns
  only) is harmless: the prover errors at deploy on a CHECK over a non-reconstructible column, so every
  ref reaching write-time is reconstructible ⇒ in the map (same invariant `rewriteToBasisTerms` relies on).
- **`??` not `||` — correct empty-array semantics.** `c.referencedWriteRowColumns ?? writeRowColumns(...)`
  preserves an empty metadata array (a CHECK with no write-row column, e.g. only foreign subquery refs)
  as "rides every op", matching pre-fix behavior for that case; `||` would have wrongly fallen back to
  the walk. Confirmed by reading.
- **Single attach site.** Only `collectLensRowLocalConstraints` sets the field; FK / set-level / parent-FK
  collectors deliberately do not (grep-confirmed across the tree).
- **Differ / persistence invisibility.** The transient field lives on `RowConstraintSchema` objects built
  at write-plan time and never flows into a persisted `tableSchema.checkConstraints`; the schema-differ
  compares `AST.TableConstraint`, never these objects. Confirmed by reading the diff + grep (the only
  non-comment occurrences are the producer and the consumer).
- **Single-source no-op.** For a non-decomposition lens the one base op holds all basis columns, so the
  gate keeps every constraint regardless of metadata-vs-walk — behavior byte-identical (full suite green).
- **DRY consolidation clean.** `collectColumnRefNames` exported from `lens-prover.ts`, duplicate deleted
  from `lens-compiler.ts`; build + lint green ⇒ no dangling/unused imports.

### Tests

- The 3 shipped regressions (single-member build-safe, single-member enforce/ABORT, cross-member defer)
  **pass** (`--grep "subquery CHECK"` ⇒ 3 passing).
- **Non-vacuity re-verified independently**: a temporary review-only test correlating the fixture's
  logical `docKey` (which maps to basis `doc_key`) reproduced a genuine build crash, then was removed;
  working tree left byte-identical to the committed state.
- Full suite: **4982 passing, 9 pending**; lint clean; `@quereus/quereus` build clean. The 9 pending are
  pre-existing (unrelated property-planner skips).

### Major finding → filed as a new fix ticket

- **`lens-rowlocal-subquery-correlated-rename-rewrite`** (new `fix/` ticket). The implement handoff
  flagged that `rewriteToBasisTerms` does not descend into subqueries, so a correlated write-row ref
  *inside* a subquery keeps its **logical** name and crashes at build when logical≠basis spelling. I
  **confirmed it is real and reachable post-fix**: a temporary test correlating logical `docKey` (basis
  `doc_key`) over the existing fixture crashed with `Column not found: docKey`. It is independent of
  decomposition (reproduces on a single-source lens too) and was explicitly out of scope for this gate
  ticket. Filed with a concrete repro, root cause, and the existing scope-aware `transformScopedExpr` /
  `ScopeContext` machinery identified as the reuse path.

### Minor / not-done, with reasons

- **No single-source-subquery-CHECK test added.** Provably a gate no-op (one op holds all columns), and
  the only real risk on that path — logical≠basis correlated rename — is the rewrite gap now tracked by
  the new fix ticket (and a same-named-column test would merely re-confirm the no-op). Documented rather
  than pinned.
- **Cross-member deferral is a documented design limitation, not a regression.** A cross-member row-local
  CHECK rides no member op and is silently deferred/unenforced (traced via debug `log`), matching the
  decomposition INSERT path. Pre-existing behavior; the gate fix only prevents the crash that previously
  masked it. Not in scope here (tracked by the `lens-decomp-constraint-gate-residuals` plan line).
- **Over-collection on qualified name collision** (`peer.title` where `title` is logical) is documented in
  the helper; it only ever makes the gate *defer* (the safe, already-conservative direction). No dedicated
  test — acceptable given the safe direction.

## Outcome

Build + 4982 tests + lint all green. One major residual (the subquery rewrite gap) filed as a follow-up
fix ticket; everything else verified. Complete.
