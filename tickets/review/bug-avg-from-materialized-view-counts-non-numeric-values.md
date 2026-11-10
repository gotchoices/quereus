description: An average answered from a materialized view's stored sum and count could differ from a direct average when the column held non-numbers, because sum skipped them while count did not. sum, avg and total now refuse non-numbers instead: a text, JSON, blob or date/time argument is rejected when the query is prepared, and a non-number arriving through an untyped column raises an error at run time.
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # toSummand, validateSummableArg, stepSum, totalFunc; NOTE at statReducer
  - packages/quereus/src/types/builtin-types.ts                     # isSummableType
  - packages/quereus/src/schema/function.ts                         # ArgTypeValidator (boolean | string)
  - packages/quereus/src/schema/window-function.ts                  # WindowFunctionSchema.validateArgTypes
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregate-derived windows carry validateArgTypes
  - packages/quereus/src/planner/building/function-call.ts          # assertArgTypesAccepted, now unconditional
  - packages/quereus/src/planner/building/expression.ts             # window case checks argument types
  - packages/quereus/src/util/coercion.ts                           # UNCOERCED_AGGREGATES now includes SUM/AVG/TOTAL
  - packages/quereus/test/util/aggregate-algebra-laws.ts            # Law 5 compares outcomes; decomposeValueArb
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts
  - packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic
  - docs/functions.md
  - docs/types-inference.md
----

# sum / avg / total reject non-numbers instead of skipping them

## What changed

The rule (maintainer decision, 2026-11-10): sum, avg and total accept numbers, booleans (1 / 0) and NULL (skipped). Anything else is an error, never a skip. That makes every value `count(x)` counts one that sum either added or refused, so avg's `sum(x) / count(x)` decomposition can no longer disagree with a direct avg.

- **Prepare time.** `sum`/`avg`/`total` declare `validateArgTypes: validateSummableArg`, which accepts `isSummableType` (= `isNumericOrUnknownType` plus BOOLEAN). TEXT, JSON, BLOB and the temporal types are rejected with `Invalid argument types for aggregate function sum: requires a numeric or boolean argument, got TEXT; use cast(x as integer) or cast(x as real)` (`StatusCode.MISMATCH`).
- **The dead gate.** The aggregate builder only called `validateArgTypes` inside `if (inferReturnType)`, so fixed-return aggregates never validated. Both branches of `buildFunctionCall` now go through one helper, `assertArgTypesAccepted`, unconditionally. The scalar branch had the same gate; every builtin scalar with a validator also infers its type, so that is a no-op for builtins and a fix for user functions.
- **Reason strings.** `validateArgTypes` now returns `boolean | string` (the new exported type `ArgTypeValidator`); a string rejects and is appended to the error. Existing boolean validators are unchanged.
- **Windows.** `WindowFunctionSchema` gained `validateArgTypes`; `registerAggregateAsWindowFunction` copies the aggregate's, and the `'windowFunction'` build case checks it, so `sum(text_col) over ()` is rejected at prepare. (`total` is not registered as a window function.)
- **Run time.** `toSummand(label, value)` is the one per-value rule, shared by `stepSum` (sum and avg still share one step) and total's reducer. Error text: `sum/avg: cannot add a text value; use cast(...)` or `total: ...`, storage class from `getSqlDataTypeName`.
- **No pre-coercion.** SUM/AVG/TOTAL joined the no-coercion set (renamed `UNCOERCED_AGGREGATES`), so numeric text in an ANY column reaches the step as text and raises. The emit-time transform now applies only to var/stddev and user aggregates. `coerceForAggregate` (public export) docs updated.
- The avg decomposition `NOTE:` was removed. A `NOTE:` at `statReducer` records that var/stddev still skip non-numbers.

## Behaviour to validate

- `select sum(s) from t` with `s text` → prepare error mentioning `cast`. Same for `avg`, `total`, `sum(s) over ()`, a BLOB column, `sum(json('5'))`, `sum(date('2020-01-01'))`.
- **A column declared with no type is BLOB in this engine** (`typeRegistry.inferType(undefined)`; inserting `'abc'` stores bytes), so `create table t(x); select sum(x) from t` is now rejected at prepare. This follows from the decision but is the most likely user surprise. `07-aggregates.sqllogic` had `empty_agg(x NULL)` and was changed to `x INTEGER NULL`.
- `sum(cast(s as real))` works.
- ANY column holding `4, true, false, null` → sum 5, avg 5/3, total 5. Adding `'abc'` or `'4'` → run-time error.
- Materialized view `sum(v)` over ANY `v`: `insert … 'abc'` errors, and the base table and view are unchanged (checked in memory and LevelDB store mode). `select avg(v)`, which the planner answers from the view, equals the direct average.
- `sum(?)`: an unbound `?` types as ANY and prepares. With values bound at prepare time the parameter is typed from the value, so `sum(?)` bound to `'4'` is rejected at prepare; bound to `5` or `true` it works. The ticket marked this acceptable.

## Tests

Added or changed for this ticket's behaviour:
- `test/util/aggregate-algebra-laws.ts` Law 5 now compares outcomes (both threw, or identical values) and takes a `decomposeValueArb` option. This is the class-level guard. I checked it with a throwaway spec (since deleted): a twin avg with the old skip step fails `decompose-combine`.
- `aggregate-algebra.spec.ts`: the avg law test passes `mixedClassDomain` (sumDomain plus `'abc'`, `'4'`, `''`, booleans, `Uint8Array`). The old "sum's non-numeric contributions are SKIPPED" test is rewritten to pin the new step rule: only NULL skips, booleans add, text/blob/JSON throw.
- `25-aggregate-edge-cases.sqllogic`: the old coercion section is replaced by prepare-time rejection (sum/avg/total, window), the cast workaround, ANY run-time errors (`'abc'`, `'4'`), booleans, and the materialized-view rollback plus avg agreement.
- `101-builtin-mutation-kills.sqllogic`: the total kills now cover total's reducer over ANY (text raises; numbers, `true`, null → 31.5).

Converted because they pinned the old coercion (each kept to what it was testing):
- `03.6` text_big → `sum(cast(v as integer))`, which still pins exact text past 2^53.
- `06.5.3` → `sum(integer(strftime(…)))`.
- `07.3`/`07.5` `wg` (b is TEXT) → `sum(b+0)` in the HAVING/window fingerprint cases, `count(b) over ()` where the test pins the GROUP BY error.
- `14-utilities` → dropped the sum-over-text query and kept min/max.
- `delta-aggregate.spec.ts` "sum over TEXT fails the exact-domain gate" → REAL argument (still residual).
- `window-aggregate-equivalence.spec.ts` domain: numeric-text arm → booleans.
- `exports.spec.ts`, `utility-edge-cases.spec.ts`, `runtime/aggregate-setup.spec.ts` → coercion routing lists updated (SUM/AVG/TOTAL uncoerced, VAR_POP coerces).
- Deleted as duplicates of the new coverage: `24-builtin-branches` `str_sum` and `total_t`, and the `aec_minmax` "sum/avg still read text as numbers" line in 25.

Validation run: `yarn build` OK; `yarn workspace @quereus/quereus run lint` clean; `yarn test` (all workspaces) green, with 11143 quereus tests passing. Store mode was run only on the edited sqllogic files, not the full `yarn test:store`.

## Known gaps / for the reviewer

- The run-time message for sum and avg reads `sum/avg: …` because they share one step function. The ticket allowed this; a `makeStepSum(name)` factory would name the function but give sum and avg separate steps.
- `fuzz.spec.ts`, `property.spec.ts` and `maintenance-equivalence.spec.ts` needed no changes. Their generators apparently never put text into sum/avg/total. The current suite passed, but I did not audit the generators.
- `quoomb-web`, sample plugins and docs examples outside `docs/functions.md` were not swept for `sum` over text columns. No tests failed in those packages.
- The scalar-branch change (validation without `inferReturnType`) has no dedicated test, since no builtin scalar reaches it.
- Merge note: `bug-window-rows-sliding-sum-drifts-on-real-values` (fix stage) also touches `stepSum` / `SumAccumulator`. Expect a textual conflict, not a semantic one.
