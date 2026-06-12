description: Set operations (UNION/INTERSECT/EXCEPT) deduplicate/compare rows under the output (left-input) attribute collations only; when the two inputs' corresponding columns carry different collations the right input's collation is silently ignored. Define a principled cross-input resolution using the comparison-collation provenance lattice.
files:
  - packages/quereus/src/runtime/emit/set-operation.ts        # dedup comparators from output attrs only (~22)
  - packages/quereus/src/planner/analysis/comparison-collation.ts
----

Once comparison collation resolves through the provenance-ranked lattice
(ticket `comparison-collation-provenance-and-precedence`: explicit > declared
column > defaulted > BINARY, plan-time error on explicit/declared same-rank
conflicts), set operations remain the one row-comparison surface that pairs
two relations' columns without consulting both sides: `emit/set-operation.ts`
builds its dedup comparators from the combined output attributes, which are
the left input's. `select c_nocase from t1 union select c_plain from t2`
dedups NOCASE; swap the branches and it dedups BINARY — the same asymmetry the
comparison lattice was introduced to remove.

Expected behavior (to be settled when picked up — the lattice gives the
vocabulary): per output column, resolve the two inputs' contributions through
the same lattice; explicit/declared conflicts should presumably be a
plan-time error like comparisons, and the resolved collation must also govern
the output attribute's collationName (what ORDER BY over the union sees) and
any sort-based set-op strategy's ordering requirement, in lockstep.

Use cases / expectations:
- UNION dedup of case-variant rows behaves identically regardless of branch
  order.
- INTERSECT/EXCEPT membership tests follow the same resolved collation as
  UNION dedup over the same inputs.
- Column-count-aligned but collation-divergent branches with explicitly
  declared collations surface the divergence to the user rather than silently
  picking the left branch.
