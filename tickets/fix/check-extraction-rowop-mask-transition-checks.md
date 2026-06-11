description: check-extraction treats every declared CHECK as a row invariant — operation-masked checks (`check on insert/update/delete`) and `old.`-qualified transition checks mint unconditional FDs/ECs/bindings/domains, producing confirmed wrong query results.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # extraction loop ignores check.operations; columnIndexFromExpr/collectColumnNames resolve old.x by bare name
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # columnIndexFromExpr docblock: qualifier on ColumnExpr is deliberately ignored
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # synthetic checks carry operations: 0 ("unused by extraction") — a mask filter must not drop them
  - packages/quereus/src/schema/table.ts                               # RowOpFlag / DEFAULT_ROWOP_MASK / RowConstraintSchema.operations, deferrable
  - packages/quereus/src/planner/building/constraint-builder.ts        # enforcement-side contrast: shouldCheckConstraint filters by operation; old./new. resolve to row images
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # where gate unit tests live
----

# CHECK fact extraction over-claims for operation-masked and transition CHECKs

Found during review of `check-extraction-collation-blind-fds` (the collation
gate review walked the enforcement-vs-extraction conformance chain and noticed
extraction never consults `check.operations` or row-image qualifiers).
Pre-existing — present before that ticket's change; both repros below confirmed
at that ticket's HEAD.

## Problem

`extractCheckConstraints` mints unconditional value facts (FDs, EC pairs,
constant pins/bindings, domain constraints) from every entry in
`tableSchema.checkConstraints`. But a CHECK is only a **row invariant** —
something every stored row satisfies — when it is enforced on every path a row
image can enter the table. Two ways that assumption breaks:

1. **Operation mask.** Enforcement filters by `shouldCheckConstraint(constraint,
   operation)` (constraint-builder.ts). A `check on insert (...)` does not run
   on UPDATE, so an UPDATE can legally store a violating row; `check on update`
   does not constrain freshly inserted rows; `check on delete` constrains no
   stored row at all. Extraction ignores `check.operations` entirely.

2. **Row-image qualifiers.** `old.<col>` (and `new.<col>`) reference the
   OLD/NEW row images at write time — a CHECK comparing them is a *transition*
   constraint, not a same-row fact. `columnIndexFromExpr` deliberately ignores
   the qualifier on `ColumnExpr` (bare-name resolution), so `check on update
   (old.a = b)` extracts as the same-row equality `a = b` → mirror FDs + EC
   pair.

## Confirmed repros (wrong results)

```sql
-- (1) mask: binding ∅→status='a' survives an UPDATE the check never sees
create table t (id integer primary key, status text, check on insert (status = 'a')) using memory;
insert into t values (1, 'a');
update t set status = 'b' where id = 1;   -- legal: check is insert-only
select * from t where status = 'b';       -- returns 0 rows; the row exists
```

```sql
-- (2) old. qualifier: transition check extracted as same-row EC a=b
create table t3 (id integer primary key, a text, b text unique, check on update (old.a = b)) using memory;
insert into t3 values (1, 'x', 'y1'), (2, 'x', 'y2');  -- legal: check is update-only
select * from t3 where a = 'x';           -- returns 0 rows; 2 rows exist
```

## Expected behavior / requirements

- A CHECK may contribute facts only when its operation mask makes it a row
  invariant: the mask must include **both** INSERT and UPDATE (DELETE
  membership is irrelevant). The default mask (`insert|update`) qualifies;
  ALTER ADD CHECK backfill validation plus the
  `permitsGrandfatheredCheckViolators` consumer gate (reference.ts) already
  cover the pre-existing-rows path for qualifying checks.
- A CHECK containing any `old.`-qualified column reference anywhere in its
  expression (body, guard disjuncts, compound operands — `collectColumnNames`
  has the same bare-name blindness as `columnIndexFromExpr`) must contribute
  no facts. `new.`-qualified references are same-row over the NEW image and
  are semantically fine for insert/update-mask checks, but today they resolve
  only by accidental qualifier-ignoring — make that explicit and pinned.
  (Self-table qualifiers `t.col` also resolve by bare name; those are sound.)
- The assertion-hoist path builds synthetic `RowConstraintSchema`s with
  `operations: 0` and calls `extractCheckConstraints` directly
  (assertion-hoist-cache.ts) — whatever filtering lands must keep those
  contributions (set a real mask on the synthetic checks or filter before the
  shared helper).
- `lens-prover`'s `enumerableDomain` consumes the same extraction
  (`getCheckExtraction`), so domain facts from masked/transition checks are
  covered by the same fix.
- Spec question to settle while here: `deferrable` / `initially deferred`
  CHECKs are enforced at commit, so same-transaction queries can see rows that
  violate them mid-transaction. Subquery checks (auto-deferred) are already
  excluded by the subquery screen in `containsNonDeterministicCall`; decide
  whether explicitly-deferrable simple checks must also be excluded from fact
  extraction.
- Pin both repros above (sqllogic or spec), plus controls: default-mask checks
  keep extracting; `check on insert, update (...)` keeps extracting;
  assertion-hoist contributions survive the mask filter.
