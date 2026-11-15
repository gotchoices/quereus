description: A query such as "x between ? and ?" now offers its bounds to the storage module exactly as "x >= ? and x <= ?" does, so indexes can seek on it instead of scanning and filtering.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # classifyValueBinding; extractBinaryConstraint; extractBetweenConstraints
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('extractBetweenConstraints')
  - packages/quereus/test/vtab/module-seek-filters.spec.ts           # placeholder box test, spelled with between
  - packages/quereus/test/logic/21.2-between-edges.sqllogic          # correlated-subquery BETWEEN seek (added in review)
  - docs/module-authoring.md                                         # "Module-listed seek arguments", BETWEEN sentence (~line 393)
----
# Offer BETWEEN with placeholder or correlated bounds to modules

## What was built

`extractBetweenConstraints` used to produce range constraints only when both bounds were plan-time literals. Now it accepts each bound the comparison path accepts: a literal, a placeholder, or an outer-query column, with or without a cast. The value-side classification that sat inline in `extractBinaryConstraint` moved into a new helper, `classifyValueBinding`, which both paths share, so `x between ? and ?` and `x >= ? and x <= ?` produce identical constraints. A literal NULL bound, a same-table column bound, any other expression bound, and NOT BETWEEN still leave the BETWEEN residual. `docs/module-authoring.md` describes the new behaviour. Implemented in `ticket(implement): between-with-placeholder-bounds-offered-to-modules`.

## Review findings

**Diff read first.** I read the implement commit before the handoff.

- **Correctness of the refactor.** `extractBinaryConstraint` keeps its 3VL NULL gate before classification. It now omits the `value: undefined` key on non-literal constraints, which no code checks for. In BETWEEN, `binding.value === null` can only be true for a literal NULL, since a dynamic binding has no `value` key. Same-table column bounds return null through the shared helper. Each half's collation still comes from `effectiveBetweenBoundCollation`. Nothing to fix.
- **Differential run (throwaway, deleted).** On the memory backend I compared indexed BETWEEN against the same query on an unindexed copy and against the comparison spelling. The cases covered placeholder bounds that are integers, numeric strings, reals and NULL, reversed bounds, mixed literal/placeholder, a text column with a cross-type bound, `cast(? as integer)` bounds, PK BETWEEN, OR of disjoint placeholder BETWEENs, a correlated scalar subquery (`t.x between o.lo and o.hi`, with NULL and reversed outer rows) and range joins. All matched, and each plain case planned as `IndexSeek` with no residual `Filter`. The correlated subquery now plans as a correlated index seek.
- **Major, pre-existing: an OR of overlapping ranges returns rows twice.** `x between 1 and 3 or x between 2 and 4` on an indexed column returns the overlapping rows twice. It does so with literals and with the comparison spelling, so this ticket did not cause it, but it adds the placeholder BETWEEN form as another way to reach it. The memory module concatenates `OR_RANGE` ranges and assumes they are disjoint. Filed as `fix/or-of-overlapping-ranges-returns-rows-twice` (repro verified). I appended this instance as evidence to `backlog/debt-index-seek-matches-unindexed-query-property`, the property test that would catch this class, and asked it to also generate OR-of-ranges predicates.
- **Tests.** The four extractor unit tests each pin a distinct new branch: parameter bounds, mixed, correlated, same-table residual. The end-to-end module-seek-filters box test checks delivery to a module. I kept all of them. The handoff called out that nothing tested the correlated-subquery shape, where a wrong answer would be easy to miss, so I added one sqllogic case in `21.2-between-edges.sqllogic`. It asserts the plan uses an index seek and checks results with NULL and reversed outer bounds. It passes on memory and in store mode.
- **Docs.** I checked `docs/module-authoring.md` (updated, accurate), `optimizer-rule-families.md` (its BETWEEN-as-`>=`/`<=` line already covers dynamic bindings; the "literal AND literal" line there is about the contradiction checker, which this ticket doesn't touch) and `memory-table.md` § NULL range bounds (still accurate: a dynamic NULL bound is rejected at run time). No changes needed.
- **Source hygiene, types, error handling, resource cleanup, performance.** The new helper is small and single-purpose, and its comments explain why rather than narrate. `ValueBinding` is a `Pick` of `PredicateConstraint`, so its types can't drift from the constraint. No resources or error paths are involved. The change adds no work beyond one classification per bound. Nothing found.
- **Tripwires.** None new. The handoff's note that the `'expression'` arm of `classifyValueBinding` can't be reached today is accurate. The `isDynamicValue` NOTE already covers widening it.

**Validation.** `yarn workspace @quereus/quereus run lint` is clean. The related specs pass (constraint-extractor, module-seek-filters, null-bound-seek, cast-seek-blocking, json-parameter-equality, parameter-array-scalar: 366 passing). The full sqllogic suite passes (388). `21.2-between-edges` also passes in store mode. I did not rerun the full `yarn test`: the implementer ran it green, and the review added only a sqllogic case.
