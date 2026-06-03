description: `WHERE col = null` and single-value `WHERE col IN (null)` on an indexed memory-vtab column return ALL rows instead of none. A NULL equality/IN-singleton literal compiles to a point-seek (plan=2) whose `equalityKey` is NULL; the runtime point-seek branch gates on `equalityKey != null`, so it skips the seek and falls through to an unbounded full-index walk — and because the constraint was marked "handled", no residual filter rejects the rows. SQL says `col = NULL` is UNKNOWN ⇒ zero rows.
prereq:
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts (primary + secondary point-seek branches gate on `plan.equalityKey != null`, line ~81 and ~168), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (standard equality-seek builder ~line 435 and legacy ~700 emit plan=2 with a NULL seek literal; the prefix-range builder ~470 also treats single-value IN as an equality prefix), packages/quereus/src/vtab/memory/layer/scan-plan.ts (buildEqualityKey returns the NULL key for plan=2)
----

## Repro

```sql
create table u (id integer primary key, v integer unique) using memory;
insert into u values (1,5),(2,7),(3,9);

select id from u where v = null;        -- returns [1,2,3]  (WRONG — expected [])
select id from u where v in (null);     -- returns [1,2,3]  (WRONG — expected [])
select id from u where v in (null,null); -- returns []       (correct: plan=5 multi-seek path)
select id from u where v in (5, null);   -- returns [1]      (correct)
```

The same is expected to reproduce for `id = null` on the primary key and for any
secondary-indexed column, since both point-seek branches in `scan-layer.ts` share the
`equalityKey != null` gate.

## Expected behavior

Any equality comparison against a NULL literal is UNKNOWN under three-valued logic, so
the predicate can never be satisfied:

- `col = null` → 0 rows
- `col in (null)` → 0 rows
- `col in (null, <non-null...>)` → already correct (rows matching the non-null members)

This must hold uniformly across: primary-key vs secondary-index seeks; the standard
equality builder, the legacy PK builder, and the prefix-range builder (which folds a
single-value IN into an equality prefix); and the store module as well as the memory
module (verify the store path independently — it may apply a residual scalar filter
and already behave correctly, in which case the fix is memory-module-local).

## Why it happens (analysis, for whoever picks this up)

A NULL-literal equality is extracted as a handled `=` (or length-1 `IN`) constraint and
compiled to a point-seek (`plan=2`) whose materialized `equalityKey` is SQL NULL. In
`scanLayer` the point-seek branches do `if (plan.equalityKey != null) { ...; return; }`
— with a NULL key that guard is false, so the branch neither seeks nor returns, and
control falls through to the unbounded index walk that yields every row. Because the
constraint was reported as handled, the planner attaches no residual predicate to
re-filter, so the spurious rows survive to the result.

This is the *single-value* analogue of the already-fixed multi-seek (plan=5) bug
(`complete/in-value-list-duplicate-or-null-row-multiplication`), which special-cased
NULL seek keys in the multi-seek branch only. The point-seek (plan=2) branch was never
given the same NULL treatment.

Note a clean fix likely belongs at the boundary where a NULL equality key is detected
(plan time: emit an EmptyResult for a provably-NULL equality, mirroring what the
multi-seek builder now does for an all-NULL IN list — see
`createEmptyResultNode` in `rule-select-access-path.ts`), rather than papering over it
in the runtime walk. Decide between the plan-time and runtime fix during fix/research.

## Notes

- Discovered while implementing `in-multiseek-explain-incount-cosmetic` (now in
  review/). That ticket only touched the plan=5 multi-seek builders and did not change
  these plan=2 paths, so this bug is pre-existing and independent.
- A regression test belongs in `test/logic/07.9-in-value-list.sqllogic` (extend the
  single-value baseline section) and/or the equality-seek coverage; assert both the
  empty result and, ideally, that the chosen plan is not a degraded full scan.
