description: When a storage module says it handles an "is null" or "is not null" filter, the engine trusts it and drops the filter; inside a transaction the isolation layer then returns the transaction's own uncommitted rows without ever checking that filter, so rows that fail it leak into the answer.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # RECLAIMABLE_OPS (~:340) and its NOTE; reattachUnconsumedConstraints (~:364)
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts      # truncationIsSafe — a LIMIT is licensed on the module's claim; confirm a reattached Filter keeps that sound
  - packages/quereus-isolation/src/isolated-table.ts                       # buildConstraintMatcher — staged rows are re-checked only against FilterInfo.constraints
  - packages/quereus/src/vtab/memory/                                       # memory module's tautological IS NOT NULL claim on a NOT NULL column (the one claim the NOTE says exists today)
repro: verified
----

Filed from the lamina board while fixing lamina slug `claimed-null-tests-leak-staged-rows-in-transaction`.

## What happens

A module's `getBestAccessPlan` may report a filter as handled (`handledFilters[i] === true`). For `=` / `IN` / ranges / `OR_RANGE` the access-path rule either turns the claimed filter into a seek constraint (`FilterInfo.constraints`) or, if it does not, `reattachUnconsumedConstraints` puts it back as a residual `Filter`. `IS NULL` and `IS NOT NULL` are in neither path: the rule never makes them seek constraints, and `RECLAIMABLE_OPS` excludes them, so a claimed null test is enforced only by the module's own scan.

That is fine for committed rows. It is wrong under `IsolationModule`: the merged read re-checks the overlay's staged rows only against `FilterInfo.constraints` (`buildConstraintMatcher`; with no constraints it matches every row), so a staged row that fails the claimed null test is emitted.

The `NOTE` on `RECLAIMABLE_OPS` already names the assumption: "Sound today: the only such claim is memory's tautological IS NOT NULL on a NOT NULL column. If a module ever claims a non-tautological non-seek op, its predicate is lost — widen this set, or make grow-retrieve refuse the claim." Lamina claims both ops on nullable columns (it serves `IS NOT NULL` as a walk of the column's value index, which holds only non-null rows, and `IS NULL` as a null prefix of a compound-index seek), so the assumption no longer holds.

## Reproduction (Quereus 4.20.2 as consumed by lamina, `IsolationModule(LaminaModule)`)

```sql
create table t (id integer primary key, a integer null);
insert into t values (1, null), (3, 4);
begin;
insert into t values (2, null), (4, 9);
select id from t where a is not null;   -- returns 2, 3, 4; expected 3, 4
```

Plan: `INDEX SCAN t USING _column_101_2`, no `Filter` above it.

```sql
create table t (id integer, a integer null, b integer, c integer, primary key (a, b, id));
insert into t values (1, null, 5, 1), (3, 4, 5, 1);
begin;
insert into t values (2, 7, 5, 5), (4, null, 5, 2);
select id from t where a is null and b = 5;   -- returns 1, 2, 4; expected 1, 4
```

Plan: `INDEX SEEK t USING _compound__pk_t_4`, no `Filter`.

A Quereus-only reproduction needs a module that claims a non-tautological `IS NULL` / `IS NOT NULL`; a test module (or a memory-module test double whose `getBestAccessPlan` claims it) under `IsolationModule` is enough.

Lamina is working around it on its side by no longer claiming the two ops (they still narrow its scan, but stay unhandled so the engine keeps its `Filter`). That costs lamina LIMIT pushdown whenever one of these tests is present.

## Expected behaviour

A query inside a transaction returns exactly the rows it would return after commit, for every filter a module reports handled.

## Options

- **Widen `RECLAIMABLE_OPS` with `IS NULL` / `IS NOT NULL`** (both carry a `sourceExpression`). Any module's claim of them is then re-applied above the scan when not consumed — which is always, since the rule never seeks on them. Smallest change; fixes every module. Points to check: (a) memory's tautological `IS NOT NULL` claim would start growing a redundant `Filter` on a NOT NULL column — either skip reattach when the column is NOT NULL, or have memory stop claiming it; plan-shape tests will say which; (b) `truncationIsSafe` licenses a LIMIT on the claim, and the reattached `Filter` then sits between the scan and the LIMIT — it can only drop staged rows the module never saw, but confirm that reasoning against the merged read.
- **Generalize: reattach every handled-but-unconsumed constraint**, not an allowlist. Closes the class (LIKE / GLOB / MATCH / NOT IN claims would be next) at the price of making any non-seek claim purely advisory for row filtering — its remaining effect would be pricing and LIMIT licensing.
- **Isolation-side:** have the overlay matcher evaluate every claimed filter on staged rows. Needs the claimed set to reach `IsolatedTable`, which `FilterInfo` does not carry today; larger change, and it leaves non-isolation consumers of the same contract unprotected.

Recommended: the first option, with the `NOTE` rewritten to state the new rule. Once published, lamina can restore its claims (and regain LIMIT pushdown) after a version bump.
