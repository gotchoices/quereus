----
description: A query with two bounds on the same column — like `where age > 10 and age > 30` — silently ignores the second one and returns too many rows.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # handledByCol (~298); range seek lower/upper `find` (~662-700); prefix-range trailing bounds (~624-637); legacy path (~841, ~914)
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts      # residual built per-constraint from handledFilters (~414, ~565)
  - packages/quereus-store/src/common/store-module.ts                      # computeBestAccessPlan PK range branch marks ALL range filters handled (~1847)
  - packages/quereus/src/vtab/memory/                                      # memory module's getBestAccessPlan — same over-claiming
difficulty: medium
----

# Redundant same-column range bounds are silently dropped, returning wrong rows

## What goes wrong

When a query puts **two or more comparisons on the same column and the same side**,
only the first is applied. The rest disappear, and the query returns rows it should
have excluded. No error, no warning — just a wrong answer.

```sql
create table t (id integer primary key);
insert into t values (10), (20), (30), (40);

select id from t where id > 10 and id > 30;
-- expected: 40
-- actual:   20, 30, 40      ← `id > 30` was silently discarded
```

This reproduces on **plain in-memory tables** (no storage plugin involved), on
memory tables with a secondary index, and on persistent-store tables using their
primary key. Each of the following returns extra rows today:

| Table kind | Query | Expected | Actual |
|---|---|---|---|
| memory, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |
| memory, secondary index on `v` | `where v > 10 and v > 30` | `4` | `2, 3, 4` |
| persistent store, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |

Upper bounds (`v < 40 and v < 20`) and mixed same-side operators
(`v > 10 and v >= 30`) fail the same way.

Note this is *not* an exotic shape. It arises naturally from generated SQL, from
views that add a bound over a query that already has one, and from
`WHERE x > :floor AND x > :other_floor` style parameterized filters.

## Why it happens

Two pieces disagree about what "this filter is handled" means.

A table module answers `getBestAccessPlan` with a `handledFilters` array — one
boolean per pushed filter — declaring which predicates it will apply itself. When a
filter is marked handled, the planner is entitled to drop the corresponding residual
`Filter` node, because the module promised to enforce it.

But the module and the planner then disagree on *which* filters actually get enforced:

- **The modules over-claim.** They mark *every* range filter on the seek column as
  handled. See the persistent store's primary-key branch in
  `computeBestAccessPlan` (`store-module.ts`), which does
  `rangeFilters.some(rf => rf.columnIndex === f.columnIndex && rf.op === f.op)` over
  all range filters on the leading PK column. The memory module does the equivalent.

- **The planner only consumes one per side.** In
  `rule-select-access-path.ts`, the range-seek path picks
  `lower = colConstraints.find(c => c.op === '>' || c.op === '>=')` and
  `upper = colConstraints.find(c => c.op === '<' || c.op === '<=')` — the **first**
  match of each, by position. Only those two become seek bounds.

- **Nothing catches the gap.** `rule-select-access-path` collapses the
  per-constraint `handledFilters` into a per-**column** set (`handledByCol`, ~line
  298). Meanwhile `rule-grow-retrieve` builds the residual predicate per-**constraint**
  (`if (!accessPlan.handledFilters[i]) …`). So a second `>` on an already-handled
  column is marked handled, is never turned into a seek bound, and is never kept as a
  residual either. Its predicate is simply gone.

The same shape exists in the prefix-range path (trailing bound `find`, ~line 624)
and the legacy access path (~line 914).

## What "fixed" looks like

Either side can be made authoritative, and the choice is the main design decision
this ticket needs to settle:

- **Tighten the modules** — a module marks handled only the constraints the planner
  will actually consume: per seek column, the first `=`, or the first lower bound and
  the first upper bound, *chosen by position* so the module's claim and the planner's
  `find` agree. Redundant duplicates stay unhandled and survive as a residual filter.

- **Or harden the planner** — teach `rule-select-access-path` to combine multiple
  same-side bounds (keep the tightest) or to reattach the ones it did not consume as
  a residual, so an over-claiming module can no longer lose a predicate.

The second is more robust: it defends against *any* module, including third-party
ones, rather than trusting each to know the rule's internal `find`-first behavior.
A module author has no reasonable way to discover that constraint order determines
which bound survives. Consider doing both — harden the planner, and correct the
modules that currently over-claim.

Whichever way it lands, the invariant worth writing down somewhere durable is:
**a module may mark a filter handled only if that filter will actually be applied**,
and the planner should not silently trust that claim when it can cheaply verify it.

## Scope

Confirmed broken: the memory module (primary key and secondary index) and the
persistent store's primary-key range branch.

Already fixed, and a working example of the module-side approach: the persistent
store's **secondary-index** access plan (`tryIndexAccessPlan` in `store-module.ts`)
now claims bounds positionally and leaves duplicates unhandled. Regression tests live
in `packages/quereus-store/test/pushdown.spec.ts` under
`redundant same-column constraints keep their predicate`. Reuse that test shape for
the cases above.

## Acceptance

- The three table shapes in the table above return the correct rows.
- Two upper bounds, and mixed same-side operators (`>` with `>=`), also behave.
- A contradictory equality pair (`where v = 20 and v = 30`) returns no rows.
- Whatever contract is chosen is documented where module authors implementing
  `getBestAccessPlan` will read it.
