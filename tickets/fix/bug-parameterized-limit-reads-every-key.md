description: A query that filters with "in (select ...)", sorts by an indexed column and has a placeholder limit reads far more rows than the same query with the limit written out, because the row-saving plan is only chosen when the limit is known in advance. Results are correct; only the amount of work differs.
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # NOTE in the header records this gap
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts # row-count assertions live here
repro: verified
----

Found while reviewing `bug-absorbed-sort-blocks-key-set-seek`. Its review measured `limit ?` bound to 1, over 1000 evenly spread keys in 2000 rows, reading 1000 rows, where the literal `limit 1` reads 2. The older plan was probably the same streaming walk the literal takes, so this may be a regression from that ticket; that part is inferred, since the old code was not run.

The maintainer decided on 2026-11-04 that this should be a ticket and fixed, in place of the `NOTE:`.

Expected: a placeholder limit reads about as few rows as the same value written out, for small limits at least, without a wrong plan when the bound value is large. Remove the `NOTE:` once this holds.
