description: Optimization — skip the lens-boundary `enforced-fk` existence check when the basis tables provably carry an equivalent foreign key (and the referenced logical relation is a faithful, non-row-reducing projection of its basis parent), so the faithful-passthrough case does not pay for a redundant double-enforcement.
prereq: lens-fk-enforcement-wiring
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/table.ts
----

## Context

`lens-fk-enforcement-wiring` lands the live child-side enforcement of the lens
prover's `enforced-fk` obligation, and deliberately chooses to **double-enforce**:
the logical FK existence check is synthesized at the lens write boundary even when
the basis tables already carry an equivalent FK that the re-planned basis write
enforces. Double-enforce is always sound; this ticket is the bounded performance
follow-up to elide the redundant check.

## The redundant case

When all of the following hold, the basis write's own child-side FK check
(`buildChildSideFKChecks`, gated by the same `foreign_keys` pragma) already
guarantees the logical FK, so the lens-level check is pure redundant cost:

1. **Single-source, value-preserving child mapping** — each logical FK child
   column maps (via the slot's reconstructible projection) to a basis child column
   with no transform (a plain column reference).
2. **An equivalent basis FK exists** on the child basis table: its `columns` equal
   the mapped basis child columns, and its referenced relation + referenced
   columns equal the basis parent + mapped basis parent columns.
3. **Row-set equivalence of the referenced relation** — the referenced *logical*
   relation's row set equals the referenced *basis* relation's row set: the
   referenced relation's compiled body is a faithful, non-row-reducing projection
   of the basis parent (no `where` / row-reducing join / aggregation that could
   make "exists in logical parent" differ from "exists in basis parent").

## Requirements

- Detect the redundant case **conservatively**: skip the lens-level FK check
  **only on provable equivalence**. Any uncertainty (multi-source, non-plain
  mapping, unresolved basis FK, a referenced relation that might filter rows)
  defaults to **enforce** (i.e. keep double-enforcing). A false "equivalent"
  verdict is a soundness hole (silently dropped enforcement) and must be
  impossible.
- No behavior change in correctness — only the elimination of a provably
  redundant runtime check.
- Where the skip applies, surface it (e.g. an introspection note / debug log) so
  the elision is observable, mirroring how the prover surfaces its other verdicts.

## Notes

Condition (3) is the hard part — proving the logical parent's row set is not a
strict subset of the basis parent's. The faithful single-source default-mapper
body (`select … from y.parent` with no predicate) is the obvious provable case;
an override with a `where` is the obvious non-provable case. Reuse the prover's
existing reconstructibility / single-source machinery
(`mappedBasisColumn`, `resolveSingleBasisSource`) and the row-preserving-path
reasoning in `planner/util/ind-utils.ts` where it helps. The detection most
naturally lives where the FK obligation is classified or where the lens FK
constraint is collected (`lens-enforcement.ts` / `lens-prover.ts`).
