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
  - docs/sql-functions.md
  - docs/types.md
  - docs/types-inference.md
----

# sum / avg / total reject non-numbers instead of skipping them

## What landed

The rule (maintainer decision, 2026-11-10): sum, avg and total accept numbers, booleans (1 / 0) and NULL (skipped). Anything else is an error, never a skip. Every value `count(x)` counts is therefore one sum either added or refused, so avg's `sum(x) / count(x)` decomposition, which a materialized view uses to answer avg, can no longer disagree with a direct avg.

- **Prepare time:** `sum`/`avg`/`total` declare `validateArgTypes: validateSummableArg` (`isSummableType` = `isNumericOrUnknownType` plus BOOLEAN). TEXT, JSON, BLOB and temporal arguments fail with `Invalid argument types for aggregate function sum: requires a numeric or boolean argument, got TEXT; use cast(...)` (MISMATCH). The aggregate builder used to call `validateArgTypes` only when the schema also had `inferReturnType`. Now `assertArgTypesAccepted` runs it unconditionally for scalar, aggregate and window calls. Validators may return a reason string (`ArgTypeValidator`, exported).
- **Windows:** aggregate-derived window functions copy the aggregate's validator, so `sum(text_col) over ()` is rejected at prepare.
- **Run time:** `toSummand` is the one per-value rule, used by sum/avg's shared step and by total's reducer. SUM/AVG/TOTAL joined `UNCOERCED_AGGREGATES`, so numeric text in an ANY column reaches the step as text and raises.
- A column declared with no type is BLOB in this engine, so `sum(x)` over it is now rejected at prepare. This is documented in functions.md.

Commit: `ticket(implement): bug-avg-from-materialized-view-counts-non-numeric-values`.

## Review findings

**Checked:**
- I read the whole implement diff (source, tests, docs) before reading the handoff.
- I ran the built engine against common query shapes. Rejected at prepare: untyped column (BLOB), TEXT column, TIMESPAN, `sum(d ->> '$.a')`. Accepted: `json_extract` and `->` (both ANY), `iif`/`case`/boolean comparisons, `coalesce`, `values`, and `sum(?)` bound to a number. Run-time error: a text value reaching a sliding `sum(...) over (rows ...)` and an ANY union branch. All of these follow the stated rule.
- Wrong-arity window calls (`sum() over ()`, `avg(v, v) over ()`) are rejected by the arity check before the validator reads `argTypes[0]`, so the unguarded index is safe.
- Plan nodes built outside the builder (the `rule-groupby-fd-simplification` picker, the materialized-view rewrite's re-aggregation) never take a TEXT argument. The rewrite sums a stored sum column, so skipping validation there is correct.
- `coerceForAggregate` / `aggregateCoercesArguments` have one routing site (`computeAggregateValueTransforms`). No other per-row coercion path bypasses the change.
- Uses of `sum`/`avg`/`total` outside the core package (quereus-store tests, planviz example, docs examples) all sum INTEGER/REAL columns or untyped examples. None is affected.
- Tests: the Law 5 change in `aggregate-algebra-laws.ts` (compare outcomes, `decomposeValueArb`) guards the whole class rather than one instance. The rewritten step-rule test and the 25-aggregate-edge-cases sections pin the specified behaviour. The converted tests keep their original intent. I found nothing to cut: no test restates the implementation or checks a mock.

**Found and fixed (minor):**
- `docs/types.md` § bigint canonicalization still listed `sum()` as a caller of `parseNumericText`. Changed to aggregate-argument coercion.
- `docs/sql-functions.md` aggregate list said nothing about the new argument rule. Added one line linking to functions.md.
- `docs/functions.md`: added that `->>` returns TEXT, so `sum(doc ->> '$.n')` is rejected, while `json_extract` and `->` pass. Users are most likely to hit this one after the untyped-column case.

**Major / tickets filed:** none. No finding met the filing bar.

**Tripwires:** none new. The implementer's `NOTE:` at `statReducer` (var/stddev still skip non-numbers; safe because they declare no algebra) is correct as written.

**Accepted as designed (per ticket):** the run-time message reads `sum/avg:` because sum and avg share one step. `sum(?)` bound to `'4'` at prepare is rejected because the parameter is typed from its value.

**Not covered:**
- `fuzz.spec.ts`, `property.spec.ts` and `maintenance-equivalence.spec.ts` pass, but their generators were not audited for whether they ever put non-numbers into sum.
- Materialized views already stored by the persistent store whose body sums a TEXT column would fail to re-plan when reloaded. The project rule says not to worry about backwards compatibility yet.

**Validation:** `yarn workspace @quereus/quereus run lint` is clean. `yarn workspace @quereus/quereus test` reports 11143 passing and 26 pending. I did not re-run the full `yarn test:store`; the implementer ran store mode on the edited sqllogic files.
