description: `WHERE col IN (<value-list>)` returns spurious / duplicated rows when the list contains a duplicate literal or a NULL. A soundness bug in the IN-value-list path (independent of DISTINCT; DISTINCT merely masks it). Surfaced by the optimizer differential fuzz test once `distinct-elimination` removes the masking DISTINCT.
files: packages/quereus/src/planner/building/expression.ts (IN value-list → InNode, ~line 254), packages/quereus/src/planner/nodes/subquery.ts (InNode), packages/quereus/src/runtime/emit/subquery.ts (InNode emit), packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts (IN→semi-join rewrite — prime suspect), packages/quereus/test/fuzz.spec.ts (the differential test that caught it)
----

## Summary

`expr IN (v1, v2, …)` over a value list is **not** evaluating set membership. It
behaves as if the row is *joined* against the value list, emitting **one output row
per matching list element**, and it **mishandles a NULL list element** (admitting
non-matching rows). The result is a relation that is a *bag* where it should be a
*set*-preserving filter.

This is a pre-existing engine bug unrelated to the view/materialized-view/lens work;
it lives in core IN-list handling.

## Minimal reproduction

```sql
create table t (k integer primary key, v integer unique);
insert into t values (1, 5), (2, 7);

select * from t where v in (5);        -- 1 row  ✓  [{k:1,v:5}]
select * from t where v in (5, 5);     -- 2 rows ✗  [{k:1,v:5},{k:1,v:5}]   (dup literal multiplies the match)
select * from t where v in (5, null);  -- 3 rows ✗  [{k:1,v:5},{k:1,v:5},{k:2,v:7}]  (dup + admits non-matching v=7)
select v from t where v in (5, 5, 9);  -- 2 rows ✗  [{v:5},{v:5}]
```

Expected: each of these is set membership — `v in (5,5)` ≡ `v in (5)` ≡ exactly the
rows whose `v` equals a (non-NULL) list element, **once**. A NULL element contributes
nothing (`x in (…, null)` is `true` if `x` equals a non-null element, else NULL ⇒ the
row is excluded by the WHERE).

Two distinct faults, both reproducible above:

1. **Duplicate list literal multiplies rows.** `in (5, 5)` returns the matching row
   twice. The IN list is not deduplicated, and matching is per-element rather than
   set-membership.
2. **NULL list element is unsound.** `in (5, null)` not only duplicates the `v=5`
   match but also returns `v=7`, which matches no list element. The NULL element is
   being treated as matching (or the rewrite's join/anti-join with NULL is wrong).

## Why it surfaced now (and the DISTINCT interaction)

The optimizer differential fuzz test `test/fuzz.spec.ts` → *"distinct elimination
produces identical results"* compares a query with all rules on vs. with
`distinct-elimination` disabled. The captured counterexample:

```
schema:  t1(c_real0 real null, c_real1 real not null primary key, c_real2 real null unique)
SQL:     select distinct * from t1 where c_real2 in (0, null, 0, 820)
rule on  → rows duplicated (e.g. the c_real2=0 row 3×)
rule off → includes c_real2=-79.79, which is not in the IN list
```

`select distinct *` was masking the IN-list row multiplication. `distinct-elimination`
correctly reasons "the base has a PK ⇒ it is a set ⇒ DISTINCT is redundant" and removes
the DISTINCT — but the IN rewrite had *already* turned the set into a bag, so the
duplicates leak through. **`distinct-elimination` is not itself wrong**; it removes a
DISTINCT whose precondition (set input) the buggy IN rewrite has violated. The bug is
fully reproducible with **no DISTINCT at all** (the `select *` cases above), confirming
IN-list handling is the root cause.

## Root-cause hypothesis (for the implement stage to confirm)

A value-list `IN` builds an `InNode` with `valueExprs`
(`planner/building/expression.ts` ~`case 'in'` → line 254). Somewhere downstream — most
likely `rule-subquery-decorrelation.ts` rewriting `IN` into a semi-join against the
value list, or the `InNode` value-list emit in `runtime/emit/subquery.ts` — the
membership test is realized as a join that yields one row per matching element and does
not impose semi-join (at-most-one-match) semantics or NULL-skip on the list side. The
fix must restore set-membership semantics: dedupe is irrelevant if membership is a
proper semi-join / scalar `OR` over distinct non-null elements, and a NULL list element
must contribute no matches.

## Acceptance

- The four minimal queries above return 1, 1, 1, 1 matching row respectively (set
  membership), and the broader `select * from t1 where c_real2 in (0, null, 0, 820)`
  returns exactly the rows whose `c_real2 ∈ {0, 820}`, once each.
- Add `.sqllogic` coverage for IN value lists with (a) duplicate literals, (b) a NULL
  element, (c) both, in WHERE, with and without DISTINCT — guarding both the dedup and
  the NULL-skip semantics.
- The `distinct elimination produces identical results` fuzz property stops finding
  this divergence.

## Related observation (separate follow-up, do not fix here)

The differential fuzz harness is **not reproducible by seed**: inside each property,
`runDifferentialTest` calls `fc.sample(queryArbitrary, …)` and `createPairedDatabases`
calls `fc.sample(arbSeedRow(table), …)`, both using fast-check's *own* RNG rather than
the property's seed. So when a real divergence is found, the printed
`{ seed, path }` reproduces only the generated *schema*, not the failing *SQL* or the
*seed rows* — making intermittent findings hard to recover. (This bug was captured only
by raising `numRuns` and reading the assertion message, which does print the SQL.)
Worth a separate ticket to seed the inner `fc.sample` calls (or thread the property's
`mrng`) so future fuzz failures are deterministically reproducible.
