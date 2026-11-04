description: The engine's optional strict mode now checks the rows table-valued functions produce against their declared column types, so a function returning the wrong kind of value is reported at the function itself. The check exposed two functions breaking their declarations, and both are fixed.
prereq: bug-generate-series-yields-non-integers
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts   # the new check; run and runIntegrated merged into one generator
  - packages/quereus/test/runtime/representation-strict.spec.ts  # the seam test
  - packages/quereus/src/func/builtins/explain.ts                # query_plan est_rows declared REAL
  - packages/sample-plugins/comprehensive-demo/index.ts          # data_summary yields text for its counts
  - packages/quereus/src/runtime/strict-flags.ts                 # seam list comment
  - packages/quereus/src/runtime/strict-representation.ts        # header comment
  - packages/quereus/src/core/statement.ts                       # egress seam comment
  - docs/types.md                                                # § Enforcement, seam table
  - docs/runtime.md                                              # strict harness section
  - docs/plugins.md                                              # the contract for table-valued function rows
----

`QUEREUS_REPR_STRICT` now has a fifth check point. With the flag on, each row a table-valued function yields is checked against its declared column types after row-width normalization. A violation throws `RepresentationError` naming the function, column and declared type, for example: `the row yielded by table-valued function bad_series(0) column 0 (value): declared type INTEGER admits ...`. With the flag off, the row loop gains one already-false branch and emit builds nothing for the check.

## What changed

**The check.** `run` and `runIntegrated` in `emitTableValuedFunctionCall` were copies of the same loop, so they are now one generator that picks the calling convention once per call. A shared helper reached through `yield*` was rejected because it would add an async hop per row with the flag off, which the ticket rules out. The surrounding `catch` rethrows `RepresentationError` unchanged, so a violation is not re-reported as `Table-valued function X failed: ...`.

**Violations found.** The strict suite passed as soon as the check landed, because no test reaches either of these. Both came from reading the declarations and then reproducing under the flag.

- `data_summary` (sample plugin): the `value` column is TEXT, but the `length` and `key_count` rows yielded numbers. Fixed the value with `String(...)`; the output shown in the plugin's README reads the same.
- `query_plan`: `est_rows` was declared INTEGER, but a five-way cross join of analyzed 2000-row tables estimates 3.2e16, a whole JS `number` past 2^53, which INTEGER does not admit. Fixed the declaration to REAL, matching `est_cost`. An estimate is a double, and no value changes. Rounding to a canonical `bigint` was rejected because diagnostic consumers such as `quoomb-web` treat the column as a `number`.

## Behaviour to check

- A function that declares no columns (`split_string`) gets rule R1 only, because its types array is empty. It is not skipped outright. The ticket allowed either; R1 binds every value regardless of declared type, and this needs no special case.
- `query_plan`'s announced type for `est_rows` (through `getColumnDefs()`) changes from INTEGER to REAL. The runtime values do not change.
- The `json_each` / `json_tree` argument-count check used to be only in the non-integrated path. After the merge it would also apply to an integrated function registered under one of those names. No in-tree function is one.

## Tests added

- `TVF seam: a fraction in a declared INTEGER column is caught and not reported as a call failure` (`representation-strict.spec.ts`, active only under the flag). Verifies the error class, function, column and declared type, and that the message is not rewrapped. It failed against both temporary mutations: check removed, and `RepresentationError` removed from the rethrow.

## Validation

- `yarn workspace @quereus/quereus test:repr-strict`: 10995 passing, 16 pending.
- `yarn workspace @quereus/quereus test`: 10985 passing, 26 pending.
- `yarn workspace @quereus/quereus lint`: exit 0.
- After `yarn workspace @quereus/quereus build`, with `QUEREUS_REPR_STRICT=1`: `@quereus/sync` 852 passing (includes `basis-lifecycle-tvf.spec.ts`), `@quereus/sample-plugins` 34 passing. `@quereus/sample-plugins` also passes without the flag.
- A throwaway spec, since deleted, confirmed the two fixes under the flag: a six-way `query_plan` and `data_summary` on an array, an object and a scalar all ran clean. Before the fixes, that `query_plan` and the array and object `data_summary` calls threw.

## Known gaps

- **No regression test for the two fixes.** One is a declaration and the other a one-line sample change, so I judged they do not meet the test bar. The suite therefore does not reach those paths under the flag. A reviewer may reasonably want a `data_summary` case, since `plugins.spec.ts` does not cover it.
- **The audit is partly by reading.** The other declarations (`json_each`, `json_tree`, `schema`, the `*_info` family, `explain`, `cardinality_feedback*`, `str_stats`, `quereus_basis_lifecycle`) were read against what they yield and looked correct. The suite exercises many of them under the flag, but I did not measure which columns and branches it reaches.
- **`cardinality_feedback`'s `catalog_rows` and `baseline_rows` were read only.** They relay row counts from the catalog and from modules. In-tree modules appear to report whole numbers, but a third-party module reporting a fractional count would trip the INTEGER declaration under the flag. I did not trace every source or run this case.
- **Not run:** full `yarn build`, `yarn typecheck`, `yarn bench:gate`, and `test:store` under the flag. The flag-off cost was not benchmarked.
- **`yarn docs:check` fails, unrelated to this ticket.** `docs/invariants.md:252` has two `guard:` lines for OPT-024, and that file is unmodified from HEAD. It is the only failure the script reports, and it is written up in `tickets/.pre-existing-error.md`. The same run warns that `docs/types.md` is at 11667 of its 12000-word cap, so that document has little room left to grow.
