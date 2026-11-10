description: When an average is answered from a materialized view's stored sum and count, values that are not numbers (such as the text 'abc') are counted in the divisor even though a direct average skips them, so the two give different answers for the same rows.
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # avgFunc.algebra.decompose (partials sum + count, combine via avgQuotient) — NOTE at the site; stepSum's skip rule; countXFunc
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # assertAggregateAlgebraLaws — decomposition law checked only over numeric domains
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Only columns that mix numbers with non-numeric text, blobs or JSON are affected, and the fix needs either a new internal count partial or a change to which values `sum`/`avg` skip, both of which touch materialized-view rollup.
----

# Decomposed `avg` divides by values `avg` itself skips

## Reproduction (verified 2026-11-10, in-memory `Database`)

Table `m(id, g, v any)` = `(1, 1, 'abc'), (2, 1, 4), (3, 2, 6)`, plus a materialized view storing `sum(v), count(v), count(*) group by g`. `select avg(v) from m` is rewritten to roll up the view and returns `3.333…` (10 / 3). Evaluated directly it returns `5` (10 / 2).

## Cause

`avg` accumulates as `sum` does: non-numeric text, blobs and JSON contribute nothing and are not counted. Its declared decomposition is `sum(x)` / `count(x)`, and `count(x)` counts every non-NULL value, including the ones `sum` skipped. The decomposition contract (`AggregateAlgebra.decompose`: `combine` over the partials equals the aggregate's own finalize over the same rows) therefore fails over any column that holds such a value. It predates the change that made `avg` accumulate as `sum` (the old float `avg` also skipped `'abc'`).

## Expected behaviour

Direct `avg(x)` and the view-rolled-up `avg(x)` agree for every column, including mixed storage classes. Direct `avg`'s current skip rule (sum's: numeric text parsed, booleans 1/0, non-numeric text / blob / JSON skipped) is the documented semantics; the divisor partial must count exactly what `sum` counts.

## Class-level guard

The decomposition law in `aggregate-algebra.spec.ts` runs each aggregate over a numeric-only domain, which is why this was not caught. Checking the decomposition law of every aggregate that declares `decompose` over a domain that also includes non-numeric text, blobs and booleans would catch this and any future decomposed aggregate with the same mismatch.
