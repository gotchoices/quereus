---
description: A query that converts a column's value before comparing it — for example matching rows where the text column read as a number equals 1 — returns no rows at all when that column is the table's primary key, but the correct rows when it is not.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # unwrapCast() — strips every CAST, not just no-op ones
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts   # isNoOpCast() — the predicate the fix needs
  - packages/quereus/src/planner/analysis/sat-checker.ts            # unwrap() — same defect, already fixed the same way
  - packages/quereus/test/planner/                                  # seek / covered-key correctness specs live near here
difficulty: medium
---

# `CAST` is erased when extracting index-seek constraints, producing wrong rows

## Reproduction (verified on `main` @ `2f09bb92`)

```sql
create table t (x text primary key);
insert into t values ('1'), ('1abc'), ('2');
select x from t where cast(x as integer) = 1;
-- actual:   (no rows)
-- expected: '1', '1abc'
```

The same predicate against a column that is **not** indexed returns the right answer:

```sql
create table u (id integer primary key, x text);
insert into u values (1,'1'), (2,'1abc'), (3,'2');
select x from u where cast(x as integer) = 1;   --> '1', '1abc'   (correct)
```

`cast(x as integer)` is a value-changing conversion (`'1abc'` → `1`), so the answers must
agree. They do not, and the indexed one is the wrong one.

## What is happening

`query_plan` for the primary-key case:

```
INDEXSEEK | INDEX SEEK t USING primary ORDER BY 0
TABLEREFERENCE | main.t
LITERAL | 1
```

There is no residual `FILTER` node left — the planner believes the seek answers the
predicate exactly.

`constraint-extractor.ts` recognizes `col = lit` comparisons and turns them into seek /
covered-key constraints. Before matching, it calls `unwrapCast()`, which unconditionally
strips a `CastNode`:

```ts
function unwrapCast(node: ScalarPlanNode): ScalarPlanNode {
	return node.nodeType === PlanNodeType.Cast ? (node as CastNode).operand : node;
}
```

So `cast(x as integer) = 1` is read as `x = 1`: a seek on `x` for the integer `1`. No stored
text value equals the integer `1` under storage-class ordering, so the seek returns nothing,
and because the constraint was reported as fully consumed the original predicate is dropped.

Stripping a *no-op* cast (target logical type equal to the operand's) is fine — the compared
value is unchanged. Stripping a converting cast is not.

## Why this is filed separately

`sat-checker.ts` had the identical defect in its own `unwrap()` and it was fixed under
ticket `core-callers-collation-resolver`: it now strips a cast only when
`isNoOpCast(node)` holds, and never strips `COLLATE`. `constraint-extractor.ts` already
refuses to strip `COLLATE` (with a long comment explaining that stripping it mints unsound
seek witnesses) — but it never extended the same reasoning to a converting `CAST`. The
`COLLATE` half of that comment is correct; the `CAST` half is the bug.

## Expected behavior

- A comparison whose column operand is wrapped in a **value-changing** cast contributes no
  seek / range / covered-key constraint, and the predicate stays as a residual filter.
- A **no-op** cast (`isNoOpCast`) may still be stripped, preserving today's folding.
- `select x from t where cast(x as integer) = 1` returns the same rows whether or not `x`
  is indexed, and whether or not an index is chosen.

## Scope notes for the implementer

- `unwrapCast` is called from `isColumnReference()` and from the literal/column shape
  matchers in the same file; a change to it affects every consumer. Check whether any
  consumer *wants* the loose behavior (e.g. a place that only asks "does this subtree
  mention exactly one column?"), and split the helper if so rather than loosening the fix.
- `isNoOpCast` already exists in `planner/analysis/scalar-invertibility.ts` and is exported.
- Expect some plan-shape tests to change: predicates that previously became seeks will fall
  back to scan + filter. A plan regression there is the *point*; verify the row counts, not
  the shapes.
- Cover both directions of the comparison (`1 = cast(x as integer)`), `BETWEEN`, `IN`, and
  the covered-key / ≤1-row claim path that the existing `COLLATE` comment names.
