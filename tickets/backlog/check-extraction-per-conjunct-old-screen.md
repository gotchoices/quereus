description: Precision refinement — screen `old.` row-image refs per AND-conjunct instead of per whole CHECK, so mixed transition/invariant checks keep contributing their invariant conjuncts.
difficulty: easy
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts         # isRowInvariantCheck / containsOldRowImageRef (whole-check today), walkConjunction (AND decomposition already exists)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts         # row-invariant gate unit block to extend
----

# Per-conjunct `old.`-screen in CHECK fact extraction

The row-invariant gate (ticket check-extraction-rowop-mask-transition-checks)
kills an entire CHECK when any `old.<col>` reference appears anywhere in its
expression. That is sound but coarser than necessary for checks that AND a
transition conjunct with plain invariant conjuncts, e.g.

```sql
check ((old.id is null or id = old.id) and status in ('a', 'i'))
```

Today this contributes nothing; the `status` enum domain is lost.

**Soundness argument for the refinement.** Under SQL ternary logic,
`C1 AND C2` is FALSE whenever C2 is FALSE (TRUE/NULL/FALSE AND FALSE are all
FALSE), so the check rejects the row whenever C2 is FALSE — regardless of C1
evaluating NULL on the INSERT path (where OLD is NULL). Every stored row
therefore satisfies "C2 not FALSE" on every enforced path, which is exactly
the guarantee a standalone `check (C2)` provides; extraction's existing
per-shape semantics then apply unchanged.

## Expected behavior

- The **mask** and **deferred** legs stay per-check (they describe when the
  whole check runs).
- The `old.`-ref screen moves from check level into `walkConjunction`'s
  conjunct level (AND decomposition already exists there): a conjunct
  containing an `old.` ref is skipped; sibling conjuncts extract normally.
- Whole-check behavior for non-AND shapes (e.g. an `old.` ref inside one
  disjunct of an implication-form OR) must remain a full kill — the
  per-conjunct argument does not extend through OR.
- Unit pins: mixed `old.`-conjunct + invariant-conjunct check contributes
  exactly the invariant conjunct's facts; `old.` inside an OR disjunct still
  kills that conjunct entirely.

Low priority: pure precision improvement; current behavior is conservative
in the sound direction.
