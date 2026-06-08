description: FIX — A `COLLATE` operator applied to a *bound* of a `BETWEEN` (e.g. `name between 'bob' collate NOCASE and 'bob'`) is silently dropped, so that comparison falls back to the tested-expression's collation (usually BINARY) and returns wrong rows. Reproduces on a bare sequential scan with no index, so it is independent of the access-path / index-collation work — it lives in constant folding or `emitBetween` collation resolution. Discovered during review of `index-collation-mismatch-residual-filter`.
files:
  - packages/quereus/src/runtime/emit/between.ts                  # emitBetween resolves collation expr → lower → upper; the lower/upper fallback is dead if folding strips the bound's collation first
  - packages/quereus/src/planner/nodes/scalar.ts                  # LiteralNode.explicitType is meant to carry COLLATE "through the folding pass"; CollateNode.generateType spreads collationName onto its operand type
  - packages/quereus/src/planner/rules/...constant folding        # locate the fold that collapses CollateNode-over-literal — confirm whether it preserves collationName on the folded LiteralNode's explicitType
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic  # add regression assertions here once fixed
----

# `COLLATE` on a BETWEEN bound is dropped

## Symptom

```sql
create table t (id integer primary key, name text);   -- name is BINARY
insert into t values (1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob');

-- BUG: returns []  (expected [{"id":2},{"id":4}])
select id from t where name between 'bob' collate NOCASE and 'bob' order by id;

-- These two equivalent forms BOTH work correctly (→ [2,4]):
select id from t where name collate NOCASE between 'bob' and 'bob' order by id;   -- expr-side COLLATE
select id from t where name >= 'bob' collate NOCASE and name <= 'bob' order by id; -- desugared
```

Reproduces with **no index on the table** — a plain `SeqScan` + `Filter(BetweenNode)`. So
this is *not* an access-path / index-seek issue; the `BETWEEN` filter itself evaluates the
`name >= 'bob' COLLATE NOCASE` comparison under BINARY instead of NOCASE.

## Expected behavior

A `COLLATE` on either bound of a `BETWEEN` must govern that bound's comparison, matching
both (a) the desugared `expr >= lo AND expr <= hi` form and (b) SQLite semantics. For the
repro, the lower comparison is NOCASE (so `'BOB' >= 'bob'` and `'Bob' >= 'bob'` are true)
and the upper is BINARY (`'BOB' <= 'bob'`, `'Bob' <= 'bob'` are true), yielding rows 2 and 4.

## Likely root cause (lead, not a conclusion)

`emitBetween` (`runtime/emit/between.ts`) already resolves the collation as
`expr ?? lower ?? upper ?? BINARY`, so the intent exists. The probable failure is upstream:
constant folding collapses `'bob' COLLATE NOCASE` into a bare `LiteralNode` **without**
carrying the collation onto its `explicitType`, so by the time `emitBetween` runs,
`plan.lower.getType().collationName` is already `undefined`. Note `LiteralNode`'s constructor
comment explicitly says `explicitType` exists so COLLATE "survives the folding pass" — verify
whether the fold that handles `CollateNode`-over-literal actually populates it for this shape.

The expr-side case works because the tested expression keeps its `CollateNode` (or the column
collation), and the desugared `>=`/`<=` case works because each comparison is a `BinaryOpNode`
whose right operand retains its collation — confirming the loss is specific to BETWEEN bounds.

## Notes / scope

- Out of scope for the access-path collation-cover fix (`index-collation-mismatch-residual-filter`),
  which only classifies *index vs predicate* collation **after** the predicate's effective
  collation is already established. That rule's `effectivePredicateCollation` BETWEEN arm
  deliberately reads only the `expr` collation precisely because the bound collation never
  survives to plan-rule time today; revisit that arm (mirror `emitBetween`'s expr→lower→upper)
  once this fold bug is fixed so a bound-collated BETWEEN over a collated index classifies the
  cover correctly too.
- Check `NOT BETWEEN` and the trailing-range index-seek path as well; the latter extracts
  BETWEEN into `>=`/`<=` seek constraints via `extractBetweenConstraints`, dropping the bound
  collation in `getLiteralValue` — so a collated bound must keep the predicate as a residual
  (or be normalized) rather than silently seeking under the wrong collation.
