description: In the strict test mode, every query result column the engine promises can never be null is now checked row by row, so a null in such a column fails the test run instead of silently breaking the promise.
prereq: builtin-results-announce-honest-nullability, scalar-subquery-nullability, grandfathered-not-null-columns-read-as-nullable
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/runtime/strict-representation.ts   # assertAnnouncedNonNull (new), module doc comment
  - packages/quereus/src/core/statement.ts                  # _iterateWithSignal + new egressReprCheck()
  - packages/quereus/src/runtime/strict-flags.ts            # REPR_STRICT doc comment
  - docs/types.md                                           # § Enforcement: QUEREUS_REPR_STRICT — seam table row + paragraph
  - docs/types-inference.md                                 # "Arithmetic nullability" closing sentence
  - docs/plugins.md                                         # § Returning values in the right JavaScript form
----

# Strict-mode egress check: announced non-null ⇒ no NULL cell

## What changed

Under `QUEREUS_REPR_STRICT=1`, the statement egress seam (`Statement._iterateWithSignal`, `core/statement.ts`) already checked each result row against each column's announced logical type (rules R1/R2, `assertRowConforms`). R2 admits null everywhere, so the announced `nullable` flag was unchecked. It is now checked too.

- `assertAnnouncedNonNull(row, nonNullIndices, types, where, columnNames)` in `runtime/strict-representation.ts`, beside `assertRowConforms`. Throws the same `RepresentationError` (StatusCode.INTERNAL) with a `repr-strict:` message naming the column ordinal and name, the announced type, and the three ways the fault can arise (a NOT NULL table column holding null, a not-null-declared function returning null, an inference missing a null path).
- In `statement.ts`, the strict-mode per-execution setup moved into a private `egressReprCheck()` that precomputes names, types and the indices of non-nullable columns once (from `columnDefCache`, exactly as R1/R2 did), and returns a per-row closure running both checks. The loop calls `repr?.(row)`. Off strict mode, nothing is built and the early `yield* source` fast path is unchanged.
- Docs: `types.md` seam table + the paragraph that pointed at the old backlog ticket now states the check and what it means for module/UDF authors; `types-inference.md` no longer says the flag is inconsistent engine-wide; `plugins.md` no longer says `null` is "always acceptable" regardless of declared type — it now says a `nullable: false` return type is a promise, and that strict mode fails a non-null-announced result column yielding null. `strict-flags.ts` and the `strict-representation.ts` header comment mention the new check.

## Validation done

- Full `packages/quereus` mocha suite **without `--bail`** under `QUEREUS_REPR_STRICT=1`: 11201 passing, 0 failing. No residual violations remain after the three prereq tickets — nothing to fix or file.
- `yarn workspace @quereus/quereus test`: 11191 passing. `test:repr-strict`: 11201 passing. `lint`: clean. `yarn docs:check`: OK.
- Confirmed the check fires (scratch script, since deleted): registered a UDF `liar` with `returnType: INTEGER_RETURN_NOT_NULL` that returns its argument. Under strict, `select liar(null) as bad` threw `repr-strict: null at the statement result row column 0 (bad), whose announced type is INTEGER NOT NULL. …`; `select liar(1)` passed; without the flag both returned rows.

## Tests

None added, per the ticket: the check is itself the net, run by `yarn check` through `test:repr-strict`.

## For the reviewer

- The prose claim in `types.md` that the lens prover relies on the flag is drawn from `types-inference.md` (the `lower(nullable_col)` / `v + 1` examples). Check the wording is not stronger than that.
- `plugins.md` says the same promise applies to a table-valued function's declared columns. That follows from egress reading announced column types, but I did not exercise a TVF case specifically.
- Only the memory-backed suite was run under strict mode (as `yarn check` does). `test:store` was not run with the flag; a store-path-only nullability violation would not be seen by `yarn check` either.
- Running `QUEREUS_COLUMNS_STRICT` together with `QUEREUS_REPR_STRICT` was not tried; they are separate runs in `yarn check`.
