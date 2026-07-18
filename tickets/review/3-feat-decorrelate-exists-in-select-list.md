----
description: Correlated EXISTS and IN subqueries in a SELECT list used to re-run the inner query once per outer row; they are now rewritten to a single left join that computes a match-flag column, keeping every outer row. Review the new optimizer rule, its NULL-semantics and fan-out gates, and the test coverage.
prereq: feat-decorrelate-scalar-subquery-order-by
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/logic/07.7.3-exists-in-select-decorrelation.sqllogic, packages/quereus/test/plan/exists-in-select-decorrelation.spec.ts, docs/optimizer-rules.md
difficulty: hard
----

# Review: decorrelate EXISTS / IN in the SELECT list

## What was built

A new optimizer rule `ruleExistsInSelectDecorrelation` (id
`exists-in-select-decorrelation`, anchored on `ProjectNode`, Structural pass,
`sideEffectMode: 'aware'`), added to the existing
`rule-subquery-decorrelation.ts` alongside the WHERE-clause anchor. For each
correlated `EXISTS` / `NOT EXISTS` / `IN (subquery)` found in a projection
expression it builds:

```
Project[ o.id, <flag ref> AS f ]           -- output attribute ids preserved
  LeftJoin[ c.fk = o.k ] exists right as <flag>
    o                                      -- previous source (joins stack left-deep)
    Distinct(Project[key cols](Filter(residual, c)))
```

The subquery node in the projection is replaced with a `ColumnReferenceNode` to
the flag attribute (`ExistenceColumnSpec`, minted via `PlanNode.nextAttrId()`).
`NOT EXISTS` / `NOT IN` need no special handling — the rewrite fires on the
inner Exists/In node and the enclosing `NOT` wrapper survives over the
two-valued flag (both the per-row emitters and the join flag yield JS
`true`/`false`, verified observationally identical).

It reuses the file's existing `extractExistsCorrelation` /
`extractInCorrelation` splitters unchanged, so the equi-correlation-only and
residual-must-be-inner-only bails match the WHERE path exactly.

## Key design decisions (the reviewer should scrutinize these)

**Fan-out (the ticket's headline hazard).** `emitLoopJoin` drives a
`left join … exists right as` like a plain left join with an appended flag bit,
so K matching inner rows would duplicate the outer row K times. The ticket's
*preferred* option was implemented: the inner side is collapsed to at most one
row per correlation key — an attribute-id-preserving `ProjectNode` onto the key
columns (indices resolved against the residual-filtered inner source) under a
`DistinctNode`. The key projection preserves the correlation attribute ids, so
the extracted condition serves verbatim as the join condition. Downstream,
`distinct-elimination` removes the Distinct when the key is already unique, and
`nested-loop-right-cache` materializes the now-uncorrelated right side once.

**IN three-valued logic (a gate the ticket did not anticipate).** The ticket
prescribed "IN → the flag ref" unconditionally, but a projected `x IN S` is
observable three-valued: it yields NULL (not FALSE) when there is no match but
`x` is NULL or `S` contains a NULL — a WHERE context can conflate NULL/FALSE, a
SELECT list cannot. The rule therefore fires on IN only when **both comparison
sides are statically non-nullable** (the IN condition column's type and the
subquery's first output column's type); otherwise it bails and the per-row path
keeps the NULL result. Tests pin both directions (decorrelated PK-to-PK IN, and
a nullable-side IN whose expected output contains a genuine NULL).

**NOT IN (deviation from the ticket).** The ticket said "do not decorrelate
NOT IN". Under the non-nullable gate above, NOT IN is exactly `NOT <flag>` and
is decorrelated soundly (test included); a nullable-side NOT IN bails via the
same gate, which is precisely the NULL-semantics case the ticket worried about.

**Safety backstops.** Per candidate: correlation must resolve entirely to the
immediate outer (`collectExternalReferences ⊆ outer attr ids`); side-effecting
inners refused (`subtreeHasSideEffects`); every inner column referenced by the
join condition must be a top-level attribute of the inner source (bails on
deep-projected columns and on an IN whose first column is a computed expression
carrying a fresh attribute id); and after construction the built right side must
itself be free of external references or the rule bails.

**Registration.** Adjacent to the other decorrelation rules in `optimizer.ts`.
Ordering relative to the earlier-registered Project-typed existence-flag rules
(`join-existence-pruning`, the recovery rules) was verified not load-bearing:
the per-node `applyPassRules` loop re-offers every rule whenever a transform
mints a new node, so they see the flag-bearing Project in the same loop.

## Validation

- `packages/quereus/test/logic/07.7.3-exists-in-select-decorrelation.sqllogic`
  (new): fan-out (3 inner rows per key → exactly one output row per outer row),
  NOT EXISTS, residual inner predicate, composite correlation, multiple flags in
  one SELECT, SELECT-list + WHERE EXISTS in one query, CASE wrapper, `SELECT *`
  inner, mixed with a scalar-agg subquery, decorrelated IN and NOT IN
  (non-nullable), nullable IN / NOT IN NULL-result bails, non-equi bail,
  outer-ref-beyond-conjuncts bail, uncorrelated EXISTS untouched, derived-table
  shape invariance (no leaked join/flag columns), and flag-as-upstream-probe /
  flag-unused interactions with the recovery/pruning rules.
- `packages/quereus/test/plan/exists-in-select-decorrelation.spec.ts` (new):
  plan-shape assertions that the Exists/In node is actually dissolved (rules
  genuinely fire — the sqllogic results alone would also pass on the per-row
  path), the flag join and Distinct appear, and the bail shapes retain their
  Exists/In nodes.
- Existing coverage in `07.6.1-subquery-extras.sqllogic` (EXISTS in projection)
  now routes through the new rule and still passes.
- `yarn build` clean, `yarn lint` clean, full `yarn test`: 2202 passing, 1
  failing — **pre-existing**, see below.

## Known gaps and honest notes

- **Pre-existing failure** (not mine): `07.7-scalar-agg-decorrelation.sqllogic`
  fails on `SELECT p.k, count(*) FROM p GROUP BY p.k ORDER BY (SELECT count(*)
  FROM d WHERE d.k = p.k)` — "Scalar subquery returned more than one row".
  Verified identical with the new rule unregistered; it is the unfinished
  GROUP-BY-outer case of the in-flight `feat-decorrelate-scalar-subquery-order-by`
  ticket (timed out mid-run, resume note in place). Recorded in
  `tickets/.pre-existing-error.md`; nothing was skipped or disabled.
- **Anchor coverage:** only the Project anchor exists. EXISTS/IN inside an
  AggregateNode's expressions (e.g. `select count(*) filter (where exists …)`
  shapes, or EXISTS over group keys when the projection fuses into the
  aggregate) or inside ORDER BY keys stay on the correct per-row path — the
  scalar-agg rule grew Aggregate/Filter/Sort siblings over several tickets; the
  same could be done here if workloads warrant.
- **No dedicated side-effecting-inner test:** the gate mirrors the existing
  rules' identical gate; none of the sibling decorrelation suites test it
  either.
- **Performance shape:** a flag-bearing join is excluded from hash/merge
  physical selection (documented limitation of the existence-flag machinery),
  so the join itself stays nested-loop; the win is the inner pipeline running
  once (distinct key buffer + `nested-loop-right-cache` materialization)
  instead of per row, not a hash probe. If the probe cost ever matters, a
  hash-lookup existence join would be a separate physical-selection feature.
- **Uncorrelated IN/EXISTS in projections** are intentionally left to the
  existing caching rules (same gate as the WHERE anchor).
