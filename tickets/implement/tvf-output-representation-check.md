description: The engine's optional strict mode checks that values match their declared types where tables, writes and functions hand them over, but it does not look at rows from table-valued functions. That gap is why a function yielding fractions in a whole-number column went unnoticed, so add the check.
prereq: bug-generate-series-yields-non-integers
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts   # the new check site; both run and runIntegrated loop over yielded rows
  - packages/quereus/src/runtime/emit/scan.ts                    # the pattern to copy: reprColumnTypes / reprColumnNames / reprWhere built only under REPR_STRICT
  - packages/quereus/src/runtime/strict-representation.ts        # assertRowConforms(row, types, where, columnNames)
  - packages/quereus/src/runtime/strict-flags.ts                 # comment says "four runtime seams"
  - packages/quereus/test/runtime/representation-strict.spec.ts  # seam tests, active under QUEREUS_REPR_STRICT
  - docs/types.md                                                # § Enforcement, table of "Four seams"
  - docs/plugins.md                                              # ~:525 relation return types
----

`QUEREUS_REPR_STRICT` asserts rules R1 and R2 of `docs/types.md` § Physical representation at four points: virtual-table scan output, DML write, scalar function return, and statement row egress (R1 only). A table-valued function's rows pass through none of the first three, and egress only applies R1, so a function whose rows contradict its declared column types is never reported. `generate_series` yielding `0.5` in an INTEGER column is the instance that exposed this: the failure surfaced in a downstream module rather than in the function. The docs' "Known gaps in coverage" list does not mention it.

A check at this boundary catches the whole class, including third-party plugins, which are bound by the same contract: "declared and checked, not enforced".

## Expected behaviour

With the flag on, each row a table-valued function yields is checked against its declared column types after row-width normalization, and a violation throws `RepresentationError` naming the function, the column and the declared type. With the flag off, the cost is one already-false branch and nothing is built at emit time, as at the other seams.

- A function that declares no columns (`split_string`) has opted out of positional typing and is not checked. `assertRowConforms` indexes by the row's length, so pass an empty types array, or skip the call.
- The violation must not be re-reported as `Table-valued function X failed: ...`. The surrounding `catch` in `run` and `runIntegrated` rewraps every non-abort error, so raise it outside that wrapping or let `RepresentationError` pass through as `AbortError` does. See the matching reasoning in `runtime/emit/scalar-function.ts`.

Declared types come from `plan.getType().columns[i].type.logicalType`.

## What this may surface

Other table-valued functions have not been audited against this check, so `yarn workspace @quereus/quereus test:repr-strict` may fail on them. Declarations to look at: `func/builtins/{json-tvf,schema,explain,cardinality-feedback,string}.ts`, `packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts`, and the sample plugins. For each failure, correct the value or the declaration at that function, whichever is wrong, in this ticket if small. If one needs real design work, file it as its own `fix/` ticket naming the function and column; the check stays on and that failure is reported through `tickets/.pre-existing-error.md` only if it is truly unrelated, never skipped.

## TODO

- Add the check to both row loops in `emitTableValuedFunctionCall`, sharing the code rather than duplicating it.
- Add one seam test to `test/runtime/representation-strict.spec.ts`, using a small registered function that yields a fraction in an INTEGER column, following how the file exercises the scalar function seam.
- Run `yarn workspace @quereus/quereus test:repr-strict` and resolve what it reports as above, then `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
- Update the seam list: `docs/types.md` (table and the "Four seams" wording), the comment in `runtime/strict-flags.ts`, the header of `runtime/strict-representation.ts` (which names the uncoerced boundaries), the comment at the egress seam in `core/statement.ts` if its count goes stale, and `docs/plugins.md` to state that a table-valued function's rows are held to the same contract.
