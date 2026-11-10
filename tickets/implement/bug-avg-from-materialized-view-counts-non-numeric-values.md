description: An average answered from a materialized view's stored sum and count can differ from a direct average when the column holds non-numbers, because the sum skips them but the count does not. Per the maintainer's decision, sum, avg and total stop skipping non-numbers: a text, JSON or blob argument is rejected when the query is prepared, and a non-number arriving at run time through an untyped column raises an error.
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # stepSum (the skip branches), sumFunc / avgFunc / totalFunc; NOTE on avgFunc.algebra.decompose to remove
  - packages/quereus/src/types/builtin-types.ts                     # isNumericOrUnknownType — add a sibling predicate that also admits BOOLEAN
  - packages/quereus/src/planner/building/function-call.ts          # aggregate branch: validateArgTypes runs only inside `if (functionSchema.inferReturnType)`
  - packages/quereus/src/planner/building/expression.ts             # 'windowFunction' case — no argument-type validation today
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # registerAggregateAsWindowFunction — how window sum/avg/total reach the aggregate schema
  - packages/quereus/src/util/coercion.ts                           # NON_NUMERIC_AGGREGATES / aggregateCoercesArguments — sum/avg/total must stop pre-coercing text
  - packages/quereus/src/runtime/emit/aggregate-setup.ts            # computeAggregateValueTransforms (consumer of aggregateCoercesArguments)
  - packages/quereus/test/util/aggregate-algebra-laws.ts            # Law 5 (decompose-combine) — must compare throw-vs-throw
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # avg law test — add the mixed-class decomposition domain
  - packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic    # lines ~42-46 pin "sum/avg coerce numeric-looking strings" — now errors
  - docs/functions.md                                               # aggregate table (~186-214)
  - docs/runtime.md                                                 # "Aggregate Context" coercion section (~1160)
repro: verified
----

# sum / avg / total reject non-numbers instead of skipping them

## Reproduction (verified 2026-11-10 against `packages/quereus/dist`)

```sql
create table m(id integer primary key, g integer, v any);
insert into m values (1,1,'abc'),(2,1,4),(3,2,6);
select avg(v) from m;                 -- 5   (direct: 10 / 2, 'abc' skipped)
create materialized view mv as select g, sum(v) sv, count(v) cv, count(*) c from m group by g;
select avg(v) from m;                 -- 3.333… (rolled up from mv: 10 / 3, count(v) counted 'abc')
```

Also observed today, all of which change under this ticket: `create table t(id integer primary key, s text)` with `'4'`, `'x'` gives `sum(s) = 4`, `avg(s) = 4`, `total(s) = 4`, and `sum(s) over ()` = 4.

## Cause

`avg` accumulates as `sum` does (`stepSum` in `aggregate.ts`): non-numeric text, blobs and JSON contribute nothing and are not counted. `avg` declares the decomposition `sum(x) / count(x)`, and `count(x)` counts every non-NULL value. Over a column holding a value `sum` skips, the decomposed divisor is larger than the direct one.

## Decision (maintainer, 2026-11-10) — the specification for this ticket

Stop skipping; make non-numbers errors.

- **Prepare time.** `sum`, `avg` and `total` accept an argument whose logical type is numeric (`isNumeric`), BOOLEAN, ANY, or NULL (`sum(null)` stays legal, as with `isNumericOrUnknownType`). Any other type — TEXT, JSON, BLOB, and the temporal types (DATE/TIME/DATETIME/TIMESTAMP/TIMESPAN are not `isNumeric`) — is rejected at prepare time with a message that tells the user to `cast`. This intentionally breaks `sum(text_col)` over numeric text.
- **Run time (only reachable through ANY).** Numbers add; booleans add as 1 / 0; NULL is skipped. Every other value — text of any kind including numeric text such as `'4'`, blobs (`Uint8Array`), JSON objects — raises an error. An ANY column is not looser than a TEXT column.
- **Why this closes the bug.** Every value the `count(x)` partial counts is now either one `sum` added or one that raised, so decomposed and direct `avg` cannot disagree. Keep `count(x)` as the divisor partial; the declared partials (`sum/same-arg`, `count/same-arg`) and the shape-pin test stay as they are.
- **Consequence to pin.** With a materialized view summing an ANY column, inserting a non-numeric value into the base table fails during view maintenance (the insert statement errors and is rolled back); with no view, the query that sums it fails. `count`, `min`, `max` are unaffected.
- `var_pop` / `var_samp` / `stddev_pop` / `stddev_samp` (`statReducer`) are not on the sum accumulator and declare no algebra, so no view can disagree with them; they are out of scope. Leave their skip behaviour alone (add a one-line `NOTE:` at `statReducer` saying they still skip non-numbers, unlike sum/avg/total, and that aligning them is a separate decision).

## Findings that shape the implementation

1. **The aggregate validation gate is dead for sum/avg/total.** In `planner/building/function-call.ts` the aggregate branch calls `validateArgTypes` only inside `if (functionSchema.inferReturnType)`. `sum`, `avg`, `total` declare a fixed `returnType`, no `inferReturnType`, so a `validateArgTypes` on them would never run. Move the validation out of that `if` so it runs whenever declared (mirror the scalar branch's structure). `AggregateFunctionSchema.validateArgTypes` already exists (`schema/function.ts:~427`) and `createAggregateFunction` already passes it through (`func/registration.ts:~402`).
2. **Window calls skip validation entirely.** `sum(s) over ()` builds through the `'windowFunction'` case in `planner/building/expression.ts`, which resolves a `WindowFunctionSchema` (not the aggregate schema) and only checks argument count. The argument logical types are already computed there (`windowArgTypes`). Either carry `validateArgTypes` onto the window schema in `registerAggregateAsWindowFunction` (`builtin-window-functions.ts`) and check it in the window case, or look up the aggregate schema; the first keeps one source of truth. The run-time error still covers ANY values arriving through a window, since window sum/avg step with the aggregate's own `stepSum`.
3. **Message must mention `cast`.** The current throw text is the generic `Invalid argument types for aggregate function <name>` (`StatusCode.MISMATCH`). The decision asks for a cast hint. Suggested: give the schema an optional hint (e.g. an `argTypeHint` string, or let `validateArgTypes` return `true | string` with the string used as the reason) and append it at both throw sites. Something like: `sum() requires a numeric argument; got TEXT — use cast(x as integer) or cast(x as real)`. Keep `StatusCode.MISMATCH`.
4. **Pre-coercion would hide numeric text in ANY.** `computeAggregateValueTransforms` (`runtime/emit/aggregate-setup.ts`) applies `coerceAggregateValue` (text → number) to every aggregate `aggregateCoercesArguments` says coerces — which today includes SUM/AVG/TOTAL. For an ANY argument holding `'4'` the step would see `4` and not raise. Add `SUM`, `AVG`, `TOTAL` to the no-coercion set in `util/coercion.ts` (rename `NON_NUMERIC_AGGREGATES` to something accurate, e.g. `UNCOERCED_AGGREGATES`, and update its doc comment and `aggregateCoercesArguments`' / `computeAggregateValueTransforms`' comments, which currently say "SUM/AVG coerce strings"). After that, the transform only ever applies to var/stddev and user aggregates. `coerceForAggregate` is a public export (`src/index.ts`); its doc comment says SUM/AVG convert numeric strings — fix it.
5. **The step must throw.** In `stepSum`, replace both "Documented skip" branches (string, and the trailing non-numeric storage class) with a thrown `QuereusError` (`StatusCode.MISMATCH`), message naming the function and the value's storage class (and that a `cast` is needed). `stepSum` is shared by sum and avg, so the message cannot hard-code `sum` unless you pass the name — a neutral "sum/avg argument" wording or a small factory (`makeStepSum(name)`) are both fine; prefer whichever keeps `sumFunc`/`avgFunc` sharing one step (the window code and the decomposition rely on them stepping identically). Drop the now-unused `parseNumericText` import if nothing else uses it.
6. **`total` gets the same rule** but keeps its own accumulator (float, `0.0` for empty set, no algebra). Rewrite its reducer: NULL → unchanged, number/bigint → add as float, boolean → 1/0, anything else → the same thrown error. Remove the `try { Number(value) } catch` block. Add the same `validateArgTypes`.
7. **Predicate.** Add next to `isNumericOrUnknownType` in `types/builtin-types.ts` a predicate such as `isSummableType` = `isNumericOrUnknownType(t) || t === BOOLEAN_TYPE` (identity test, same caveat as the existing NOTE there). Export it from `types/index.ts` only if something outside `src/func` needs it.
8. **Remove the avg decomposition NOTE** in `aggregate.ts` (`avgFunc.algebra.decompose`) — the condition it describes can no longer occur. Update the `stepSum` / sum header comments and the avg header comment ("the divisor is sum's count of numeric contributions") to say non-numbers raise.
9. **Parameters.** Check how `sum(?)` is typed at prepare time (`ParameterReferenceNode.getType`). If a parameter types as ANY/NULL before binding it passes the gate and the run-time rule covers a bound string; if it is typed from the bound value, `sum(?)` bound to text is rejected at prepare — acceptable, but confirm the plain numeric-bound case still prepares.
10. **Related open ticket.** `bug-window-rows-sliding-sum-drifts-on-real-values` (fix stage) also edits `SumAccumulator`/`stepSum` area for a different cause (float retraction in sliding windows). No ordering dependency; expect a textual merge if both land close together.

## Tests

- **Class-level guard (decomposition law).** In `test/util/aggregate-algebra-laws.ts` Law 5, evaluate each side as an outcome — `{ threw: true }` or `{ value }` — and require the same kind (both threw, or both returned identical values). Add an option (e.g. `decomposeValueArb`, alongside the existing `decodeValueArb`) so the decomposition law can run over a wider domain than the merge/step laws, which would throw on text. In `aggregate-algebra.spec.ts`, pass avg a domain of `sumDomain` plus non-numeric text, numeric text (`'4'`), `Uint8Array` blobs and booleans. Before the fix this fails (direct avg skips `'abc'`, the combine counts it); after, both sides raise on any text/blob row, and booleans agree.
- **sqllogic** (one new file or added to an existing aggregate file, e.g. `25-aggregate-edge-cases.sqllogic`): prepare-time rejection for `sum`/`avg`/`total` over a TEXT column, a window `sum(text_col) over ()`, and the cast workaround succeeding; run-time error over an ANY column holding `'abc'` and holding `'4'`; booleans summing as 1/0 over an ANY column; the materialized-view consequence (MV `sum(v)` over ANY `v`, then `insert … 'abc'` errors and the base table and view are unchanged; and the original repro's direct `avg` vs rolled-up `avg` agree once only numbers are present). Use the sqllogic error-expectation syntax already used in `90.6-select-error-paths.sqllogic`.
- **Existing tests expected to change** (found by grep; the full run will find the rest): `25-aggregate-edge-cases.sqllogic` ~42-46 (pins coercion of numeric strings), `24-builtin-branches.sqllogic` ~339 (`str_sum`), `03.6-type-system.sqllogic` ~579 (`text_big`), `101-builtin-mutation-kills.sqllogic` ~792 (`total` over text), `06.5.3-undeclared-return-type-comparison.sqllogic` ~220 (`sum(strftime(...))` — strftime returns TEXT; switch to a cast). Convert each to the cast form or to an error expectation, whichever preserves what the test was pinning. Property/fuzz specs (`fuzz.spec.ts`, `property.spec.ts`, `incremental/maintenance-equivalence.spec.ts`) may generate sum/avg/total over text or mixed-ANY columns; if they start failing, restrict their generators to legal argument types rather than catching the error.

## Docs

- `docs/functions.md` aggregate table and the "Difference from SQLite" paragraph: sum/avg/total require numeric, boolean or untyped arguments; text/JSON/blob/temporal arguments are rejected at prepare (cast them); in an untyped column a non-number raises. Note this departs from SQLite, which coerces/skips.
- `docs/runtime.md` "Aggregate Context" section: SUM/AVG/TOTAL no longer coerce strings.
- Grep `docs/` for other mentions of sum's skip rule (`docs/types.md`, `docs/materialized-views.md`, `docs/mv-maintenance.md`) and update.

## TODO

- Add the summable-type predicate in `types/builtin-types.ts`.
- Make aggregate `validateArgTypes` run unconditionally in `function-call.ts`; add validation to the window-function path; add a cast hint to the error message.
- Add `validateArgTypes` to `sumFunc`, `avgFunc`, `totalFunc`.
- Make `stepSum` and `total`'s reducer throw on non-numeric, non-boolean, non-NULL values; remove the skip comments and the avg decomposition NOTE; update header comments.
- Stop pre-coercing SUM/AVG/TOTAL arguments in `util/coercion.ts`; update comments in `coercion.ts` and `aggregate-setup.ts`.
- Add the `NOTE:` at `statReducer` about var/stddev still skipping.
- Extend Law 5 in `aggregate-algebra-laws.ts` to compare throw outcomes, with a separate decomposition domain; add the mixed-class avg domain in `aggregate-algebra.spec.ts`.
- Add the sqllogic coverage listed above; fix the existing tests that pinned coercion/skip.
- Update `docs/functions.md`, `docs/runtime.md`, and any other doc describing the skip rule.
- `yarn build`, `yarn workspace @quereus/quereus run lint`, `yarn test`.
