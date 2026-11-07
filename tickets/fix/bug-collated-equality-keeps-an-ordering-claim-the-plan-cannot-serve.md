description: A query that filters a column with `= 'x' collate nocase` and asks for rows in index order can come back mis-ordered, because a table module is not told which collation the equality compares under, and the planner keeps the index's ordering promise after it has dropped the index seek that made the promise true.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`classifyCollationCover` and the `useIndex` decline below it), packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (`trySortAbsorbViaIndexOrdering`, `buildRequest`), packages/quereus/src/planner/analysis/constraint-extractor.ts (`equalityConstraintCollationOk`), packages/quereus/src/vtab/best-access-plan.ts (`PredicateConstraint`), packages/quereus/src/vtab/memory/module.ts (`collectEqualityBoundColumns`)
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) keeps its own copy as a blocked ticket, `quereus-a-collate-nocase-equality-keeps-an-ordering-claim-the-plan-cannot-serve`.

## What goes wrong

Measured on 4.25.0 with a memory table and an Optimystic table holding the same rows:

```sql
create table t (id text primary key, b text, c text);
create index idx_bc on t(b, c);
insert into t values ('1','X','b'), ('2','x','a'), ('3','y','c'), ('4','x','d');
```

| statement | memory table | Optimystic table | returned (both) | correct |
|---|---|---|---|---|
| `select id from t where b = 'x' collate nocase order by c` | `FILTER` over `INDEXSCAN … USING idx_bc`, no `SORT` | `FILTER` over `SEQSCAN`, no `SORT` | 1, 2, 4 | 2, 1, 4 |

The filter keeps rows 1 (`'X'`, c = `'b'`), 2 (`'x'`, c = `'a'`) and 4 (`'x'`, c = `'d'`); ordered by `c` they are 2, 1, 4. Both tables returned the `'X'` group ahead of the `'x'` group.

On 5.0.0 the memory table returns 2, 1, 4, because its plan is now `SORT` over `FILTER` over `SEQSCAN`. No 5.0.0 change touches the two sites below, so a module that pins the column (as Optimystic and the memory module's seek candidate both do) is expected to still hit it. A reproduction on 5.0.0 needs a module whose seek candidate wins the pricing.

## Cause

Read from the code and confirmed by the 4.25.0 plans. Two sites.

**The engine keeps the ordering claim after declining the seek.** A module answers with a seek on `b` through `idx_bc` that claims the ordering on `c` within the sought prefix. The Sort is removed on that claim (`trySortAbsorbViaIndexOrdering`). Physical selection then runs `classifyCollationCover` over the seek's consumed constraints, finds NOCASE over a BINARY key column (`MISMATCH_UNSAFE`), and answers with `createSeqScan` plus the residual filter. The Sort is already gone, so the sequential scan's order is what the statement returns.

**A module cannot see which collation an equality compares under.** As `equalityConstraintCollationOk` notes, constant folding collapses `'x' collate nocase` into a literal whose type carries the collation, so the equality reaches `request.filters` as an ordinary `=`. `PredicateConstraint` has no collation field. The memory module's `collectEqualityBoundColumns` therefore treats `b` as pinned and claims that a walk of `idx_bc` delivers `order by c`. It does not: `'X'` and `'x'` sit in separate groups of the index. The cover check never sees a walk's filters, because a walk claims none.

## Proposed change

1. **Carry the comparison's effective collation on the constraint.** Add `collation?: string` to `PredicateConstraint`, filled in `buildRequest` with the value `effectivePredicateCollation` already computes for the cover check. A module pins an equality only when `collationRefines(constraint.collation ?? 'BINARY', column.collation ?? 'BINARY')`; change `collectEqualityBoundColumns` so. An older module ignores the field and behaves as today. Document the field in `docs/module-authoring.md`.
2. **Never absorb a Sort the physical plan then cannot serve.** Run the collation cover classification for the seek's consumed constraints inside `trySortAbsorbViaIndexOrdering`, before the Sort is removed, and refuse the absorb when it would decline the seek. (The alternative, building a Sort over the sequential scan in the `useIndex` decline branch when `orderingLoadBearing` is set, splits the rule across two places.)

Add the table above as a logic test, plus `where b = 'x' order by c` (BINARY equality, which must keep its index) and `where b = 'x' collate nocase order by b, c`.

Reading the collation off `sourceExpression` in each module was rejected downstream: it needs planner-internal node types and the comparison-collation lattice, which the engine does not export, so each module would carry a drifting copy of the engine's rule.

## If nothing is done

Mis-ordered rows whenever an equality compared under a coarser collation than its column's meets an `order by` the index could serve. A plain `=` on a BINARY column is unaffected.
