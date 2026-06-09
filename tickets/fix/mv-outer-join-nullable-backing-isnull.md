description: A materialized view over an outer (left/full) join stamps its backing column for the null-extended (lookup) side as NOT NULL, because the MV body's root output type reports that column as non-nullable even though an outer join null-extends it. The maintained DATA is correct (the null-extended rows are physically stored), but a query against the MV with an `is null` / `is not null` predicate on that column folds against the backing's bogus NOT NULL and returns WRONG results — violating the core MV contract that a materialized view is observably indistinguishable from the plain view. Found by the `mv-comprehensive-coverage-net` review (the new outer-join full-rebuild floor coverage exposed it).
files: packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
----

## Symptom (reproduced)

```sql
create table p (id integer primary key, name text);
create table t (id integer primary key, fk integer);
insert into p (id, name) values (1, 'a'), (2, 'b'), (3, 'c');
insert into t (id, fk) values (1, 1), (2, 9), (3, 2);   -- fk=9 has no matching p
create materialized view mv as select t.id, t.fk, p.name from t left join p on t.fk = p.id;

select id, fk, name from mv;                 -- → (1,1,'a'), (2,9,NULL), (3,2,'b')   ✅ data correct
select id from mv where name is null;        -- → []                                  ❌ should be (2)
select id from mv where name is not null;    -- → (1),(2),(3)                          ❌ should be (1),(3)
select id from mv where name = 'a';          -- → (1)                                 ✅ (equality path unaffected)
```

The plain (non-materialized) equivalents all return the null-extended row correctly:

```sql
select t.id from t left join p on t.fk = p.id where p.name is null;                      -- → (2)  ✅
-- and the same through an aliased subquery / CTE projection → (2)  ✅
```

So this is **MV-backing-specific**, not a general outer-join evaluation bug.

## Root cause

Two contributing facts; fixing either resolves the observable bug, but the first is the real defect:

1. **The MV body's root output column nullability is wrong for an outer-join null-extended column.**
   `buildJoinAttributes` / `buildJoinRelationType` (`join-utils.ts`) *correctly* mark the lookup side
   (`p.*`) `nullable: true` for a `left`/`full` join. But the `ProjectNode` sitting on top of the join
   (`select … p.name …`) re-derives the output column's type and reports `p.name` as **non-nullable** —
   it resolves the column reference back to the base column's declared type (in this DB `p.name` is
   `text` → Third-Manifesto NOT NULL) instead of honoring the nullable join-output attribute it
   actually reads. Confirmed by white-box probe: BOTH `root.getType().columns` AND
   `root.getAttributes()` report `name → nullable: false` for the body above.

2. **`deriveBackingShape` trusts that flag.** `materialized-view-helpers.ts:91` sets
   `notNull: c.type.nullable === false` from the body root's column type, so the backing table column
   `name` is declared NOT NULL. Unlike a *derived* relation's optimistic `nullable` flag (which the
   live-query `is null` path does **not** fold against), a **base-table column declared NOT NULL** is a
   hard fact the optimizer folds `… is null → FALSE` / `… is not null → TRUE` against. The MV backing
   is a real base table, so the wrong nullability becomes load-bearing and breaks read-side folding.

The equality predicate (`name = 'a'`) is unaffected because it does not depend on the nullable fold.

## Required fix

Make the projection-over-outer-join output column nullability correct so the backing column is
declared nullable when the body can produce NULL — i.e. a `ProjectNode` (and any column-ref type
resolution above an outer join) must honor the nullable **join-output attribute** it reads, not
re-resolve to the base column's declared type. This is the general, correct fix: the
`RelationType.columns[].type.nullable` / attribute `nullable` flag for an outer-join-derived column
must be trustworthy. `deriveBackingShape` then stamps the backing column nullable automatically and
the read-side fold disappears.

Investigate `project-node.ts` output-type derivation (how it types a column-ref to an input
attribute) as the primary suspect; the join nullability in `join-utils.ts` is already correct, so the
loss is in the projection/column-ref layer above it. A defensive backstop at
`materialized-view-helpers.ts:91` (only declare NOT NULL when *provably* so) is acceptable as a
secondary guard but must not substitute for fixing the type derivation, since other consumers of
`RelationType.columns[].nullable` over outer joins would still be misinformed.

Blast radius to consider while fixing: any code that trusts an outer-join-derived column's static
`nullable` flag (predicate folding, null-rejection rewrites, index/constraint inference). The plain
query path currently happens to evaluate correctly *despite* the wrong flag — verify the fix does not
change correct behavior there.

## Acceptance

- The repro above: `where name is null` → `(2)`; `where name is not null` → `(1),(3)`; full scan and
  equality unchanged. Same for a `full` outer join's both-sided null extension and for a null source
  `fk` (an `fk is null` query over the MV).
- White-box: `deriveBackingShape` (or `registeredPlanKind` MV's backing schema) reports the
  null-extended column as `notNull: false`.
- Add an outer-join `is null` / `is not null` equivalence case to
  `maintenance-equivalence.spec.ts` (the existing outer-join suite currently reads the null-extended
  row directly precisely *because* of this bug — see its comment; switch it back to the natural
  `where name is null` read once fixed) and an end-to-end leg in
  `53-materialized-views-rowtime.sqllogic`.
- `yarn test` + `yarn lint` green.
