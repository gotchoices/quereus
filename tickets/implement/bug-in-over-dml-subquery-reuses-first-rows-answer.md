description: `x in (insert ... returning ...)` works out its answer for the first outer row and reuses that answer for every other row, so a query over more than one row returns the wrong rows. Fix it to remember the returned values instead of the first answer.
architecture: docs/runtime.md#impure-subquery-emitters-full-drain--run-once
files:
  - packages/quereus/src/runtime/emit/subquery.ts   # emitIn: impure branch (runImpure) and the set-probe branch (runSetProbe) it should share code with
  - packages/quereus/src/runtime/types.ts           # RuntimeContext.inSetProbes — the per-execution slot map the fix reuses
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic   # section 2 covers one constant probe only; add the multi-row cases
  - docs/runtime.md                                 # "Impure subquery emitters" section says the IN *answer* is memoized — that is the bug
repro: verified
----

## Problem

An `IN` whose right-hand side is a data-changing statement (DML with `RETURNING`) must run that statement exactly once per statement execution and drain it fully. `emitIn`'s impure branch (`runImpure`, `packages/quereus/src/runtime/emit/subquery.ts` around line 274) does the run-once part by storing a result in `rctx.executionMemo` — but what it stores is the three-valued answer (`true` / `false` / `NULL`) computed for the *first* probe value. Every later call returns that stored answer without looking at its own `condition`.

Reproduced (memory module, plain INTEGER and TEXT columns, no type conversion involved):

```sql
create table n (id integer primary key, i integer null);
insert into n values (1, 10), (2, 20);
create table w (k integer primary key, v integer null);
select id from n where i in (insert into w values (1, 10) returning v);
-- actual: ids 1 and 2; expected: only id 1

create table tt (id integer primary key, s text null);
insert into tt values (1, 'a'), (2, 'b');
create table w2 (k integer primary key, v text null);
select id from tt where s in (insert into w2 values (1, 'b') returning v);
-- actual: no rows; expected: id 2
```

The existing logic test (section 2 of `01.9-query-expr-dml.sqllogic`) evaluates the `IN` once with a constant probe, so it cannot see this.

## Fix

Memoize the **membership set**, not the answer. The uncorrelated set-probe branch in the same function (`runSetProbe`) already does exactly the right thing for pure sources: drain the inner once into a value set keyed under the membership collation (`createValueSet` + `compareSqlValuesFast(…, collation)`), apply `memberKey` to each value, track `hasNull` for values that are or coerce to NULL, store `{ tree, hasNull }` in `rctx.inSetProbes` under a per-emit-site symbol, then probe per call: hit → `true`; miss → `hasNull ? null : false`.

The impure branch should use the same structure, with one difference that is required by the full-drain/run-once contract: **build the set on the first call unconditionally**, before the NULL-condition short-circuit. The current impure path drains the DML even when the first probe is NULL (or coerces to NULL); the set-probe path deliberately does not build for a NULL probe. Keep the impure behaviour: the write must fire on the first evaluation regardless of the probe value. After the build, a NULL condition (or one whose `probeKey` is NULL) returns `NULL`, and otherwise probe the set.

Suggested shape (keep it DRY — small helpers rather than two copies of the drain loop):

- Extract the drain loop from `runSetProbe` into a helper, e.g. `drainMembershipSet(input, collation, memberKey): Promise<{ tree, hasNull }>`. It already fully drains (no early exit), so it satisfies full-drain for the impure case too.
- Extract the three-valued probe into a helper, e.g. `probeMembership(probe, conditionKey): SqlValue`.
- `runSetProbe`: unchanged behaviour — key the condition first, return NULL before building if the key is NULL, then get-or-build and probe.
- impure `runImpure`: get-or-build first (always), then key the condition and probe. Store under its own symbol (e.g. `Symbol('IN(impure)')`) in `rctx.inSetProbes`. `executionMemo` is typed `{ value: SqlValue }` and is only for scalar answers; the scalar and `EXISTS` impure paths keep using it (their single answer genuinely does not depend on the outer row).
- `inSetProbes` already resets per execution and is already shared through `ParallelDriver` (`packages/quereus/src/runtime/parallel-driver.ts` comments around lines 57–96) — check those comments still describe the slot's users accurately after the impure branch starts using it, and update them if they say it is uncorrelated-set-probe only.

Correlated impure inners keep run-once semantics (the DML still fires once per execution; the set built from that single run is probed per outer row). That matches the existing contract for scalar/`EXISTS` and is not a change here.

Out of scope: an `IN` over DML that is never evaluated (e.g. the outer has zero rows) never fires the write. That is the existing behaviour for all three impure emitters and not what this ticket is about.

## Tests

Add to section 2 of `packages/quereus/test/logic/01.9-query-expr-dml.sqllogic` (one case per behaviour, lowercase SQL):

- The two reproductions above (integer probe over multiple outer rows → only the matching row; text probe where the first outer row misses and the second hits → only the second row). Also assert the DML table has exactly one row afterwards (run-once still holds).
- NULL handling over multiple outer rows: an inner returning `(10), (null)` probed by outer values `10` and `20` gives `true` and `NULL` respectively (select the `in` as a column, e.g. `select id, i in (insert … returning v) as m from n order by id`).
- First outer probe NULL still fires the write: outer rows with `i` = NULL then 10; result NULL then true; DML table count 1.

## TODO

- Extract the set drain and three-valued probe helpers from `runSetProbe` in `packages/quereus/src/runtime/emit/subquery.ts`.
- Rewrite the impure `IN` branch to build (unconditionally, on first call) and memoize the set in `rctx.inSetProbes`, then probe per call; remove its use of `executionMemo`.
- Update the `inSetProbes` doc comments in `runtime/types.ts` / `parallel-driver.ts` if they describe it as set-probe-only.
- Update `docs/runtime.md` "Impure subquery emitters" — the run-once bullet should say `IN` memoizes the drained membership set and probes it per call (scalar/`EXISTS` memoize their answer); also check `docs/runtime-caching.md#in-subquery-set-probe` for a sentence to adjust.
- Add the logic tests above; run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
