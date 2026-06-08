description: LEFT JOIN with `WHERE <right-side> IS NULL` over a NOT NULL right-side column — investigation; bug does not reproduce in quereus
files:
  packages/quereus/test/logic/26.1-left-join-isnull-on-notnull.sqllogic
  packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
  packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/nodes/join-utils.ts
  packages/quereus/src/runtime/emit/join-output.ts
----

## Outcome

**No engine change needed — quereus already handles this correctly.**
The bug surfaced via the `lamina-quereus-test` harness (an external
backend integration) but is not reproducible in upstream quereus
against either the memory or LevelDB store backend. The follow-up
work, if any, belongs in the lamina backend, not here.

## What was investigated

Reproducer from the original ticket:

```sql
create table lj_t1 (a integer primary key, b text);
create table lj_t2 (c integer not null, d integer not null);
insert into lj_t1 values (1, 'x'), (2, 'y'), (3, 'z');
insert into lj_t2 values (1, 10), (2, 20);
select count(*) as cnt from lj_t1 left join lj_t2 on a = c where d is null;
-- expected: [{"cnt":1}]
```

Verified outcomes:

- `yarn test --grep "26\.1"` → 1 passing (memory backend)
- `QUEREUS_TEST_STORE=true yarn test --grep "26\.1"` → 1 passing (store backend)
- All three assertions in `26.1-left-join-isnull-on-notnull.sqllogic`
  match (lines 14, 18, 23).
- The companion fixture `26.2-left-join-on-vs-where.sqllogic` exercises
  the same anti-join idiom on a NOT NULL column at line 26
  (`where ow_r.id is null` against `ow_r.id integer primary key` →
  expected `[{"lid":3}]`) and also passes.

Plan dump for the reproducer (memory backend):

```
StreamAggregate(STREAM AGG count() AS cnt)
  Filter(WHERE d is null)
    MergeJoin(LEFT MERGE JOIN on [12=14])
      IndexScan(INDEX SCAN lj_t1 USING _primary_)
      TableReference(main.lj_t2)
```

The `Filter` sits **above** the LEFT MERGE JOIN, so it operates on the
post-null-padded join output — exactly as required for the anti-join
idiom. Result: `cnt = 1`. ✓

## Why the planner is correct here

The hypotheses raised in the original ticket were checked and found
not to apply:

- **No predicate pushdown across joins.**
  `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts`
  only commutes `Filter` across `Sort`, `Distinct`, eligible `Project`,
  `Alias`, and into `Retrieve`. There is no rule that pushes a Filter
  through a `JoinNode`, so the WHERE predicate cannot leak below the
  LEFT JOIN's null-padding step.
- **No LEFT-to-INNER conversion rule exists.** A search of
  `packages/quereus/src/planner/rules/join/` turned up
  `rule-join-greedy-commute`, `rule-join-key-inference`,
  `rule-join-physical-selection`, and `rule-quickpick-enumeration` —
  none rewrite join type based on residual predicates.
- **Schema-declared `NOT NULL` is not used to fold `IS NULL` to
  false in the planner.** `predicate-normalizer.ts` performs De Morgan,
  comparison flipping, and OR→IN collapse only — it never inspects
  column nullability. `constraint-extractor.ts` records `IS NULL`
  constraints to push to vtab modules but does not constant-fold them.
- **Right-side attribute nullability is correctly relaxed for LEFT
  joins.** `join-utils.ts:buildJoinAttributes` and
  `buildJoinRelationType` both override `nullable: true` on the
  right-side columns of a LEFT JOIN, so any downstream consumer that
  did try to fold based on output nullability would see the column as
  nullable.
- **Runtime null-padding is correct.**
  `runtime/emit/join-output.ts:joinOutputRow` emits a null-padded row
  for unmatched left rows under LEFT semantics.

## Where the divergence likely lives (pointer for lamina)

If `lamina-quereus-test` reports `cnt = 3` for the same fixture, the
divergence almost certainly lives in the lamina vtab/storage module's
`xBestIndex` (or equivalent) accepting an `IS NULL` constraint on a
NOT NULL column and returning a row set that confuses the join
output — for example by returning all rows of `lj_t1` unjoined, or by
mis-reporting the join result. The relevant interfaces to check on
that side:

- `packages/quereus/src/vtab/best-access-plan.ts` — `PredicateConstraint`
  carries the `IS NULL` op down to the module.
- The vtab module's filter implementation: an `IS NULL` constraint on
  a column the module knows is NOT NULL must still be evaluated
  faithfully (i.e., it filters to zero rows from that table — but the
  outer LEFT JOIN's null-padding step is independent of and runs after
  the right-side scan).

In quereus's own memory and store modules, this idiom is exercised by
fixtures `26.1` and `26.2` and works as intended.

## Validation

```sh
cd packages/quereus
yarn test --grep "26\."          # 4 passing (26.1, 26.2, 26.3, 26.4)
QUEREUS_TEST_STORE=true yarn test --grep "26\.1"   # 1 passing
```

No code changes were needed. The fixtures already cover the regression
surface.
