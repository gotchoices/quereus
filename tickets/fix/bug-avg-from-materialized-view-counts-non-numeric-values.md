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

## Decision (maintainer, 2026-11-10)

Stop skipping non-numbers; make them errors. This replaces the "expected behaviour" above (the skip rule is no longer the documented semantics).

- **Compile time.** `sum` and `avg` require an argument whose logical type is numeric, boolean, or ANY. A text, JSON or blob argument is rejected at prepare time, with a message saying to `cast`. This breaks `sum(text_col)` over numeric text, which is converted today; that is intended.
- **Run time, ANY only.** Numbers add; booleans add as 1 / 0; NULL is skipped as before. Any other value, text included (even numeric text such as `'4'`), raises an error. An ANY column is not looser than a text column.
- **Why this closes the bug.** Every value the `count(x)` partial counts is either one `sum` added or one that raised, so the decomposed and direct `avg` cannot differ. Keep `count(x)` as the divisor partial.
- **Consequence to pin with tests.** With a materialized view that sums an ANY column, inserting a non-numeric value into the base table fails during view maintenance; without one, the query that sums it fails. `count`, `min`, `max` are unaffected.
- **Check other aggregates on the same accumulator** (`total`, if present, and anything else built on `stepSum`) and apply the same rule. Extend the decomposition-law check in `aggregate-algebra.spec.ts` to a domain with text, blobs and booleans, as the class-level guard above says, now asserting both sides raise on the non-numeric values. Update `docs/functions.md` and any doc describing sum's skip rule.
