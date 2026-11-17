description: Add a permanent test-mode check that every result column the engine promises can never be null really never produces a null, so the promise cannot quietly become false again.
prereq: builtin-results-announce-honest-nullability, scalar-subquery-nullability, grandfathered-not-null-columns-read-as-nullable
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/core/statement.ts                  # _iterateWithSignal — the egress seam; the comment there names this axis as unchecked
  - packages/quereus/src/runtime/strict-representation.ts   # assertRowConforms — where the R1/R2 check lives; put the new check beside it
  - packages/quereus/src/runtime/strict-flags.ts            # REPR_STRICT
  - packages/quereus/test-runner.mjs                        # --repr-strict
  - docs/types.md                                           # § Enforcement: QUEREUS_REPR_STRICT — "a further axis R2 does not cover"
----

# Strict-mode egress check: announced non-null ⇒ no NULL cell

## Background

Under `QUEREUS_REPR_STRICT=1`, `Statement._iterateWithSignal` (`core/statement.ts`) checks every result row against each column's announced logical type (`assertRowConforms`, rules R1/R2). R2 admits NULL in every position, so the announced `nullable` flag is unchecked; the comment at that seam and `docs/types.md` § Enforcement both say so.

A measurement on 2026-11-16 — the check below added temporarily at that seam, full `packages/quereus` mocha suite run without `--bail` under `QUEREUS_REPR_STRICT=1` — found 91 violating cells in 76 distinct (statement, column) pairs. Every one fell into one of three classes, each fixed by a prereq ticket:

| class | fixed by |
|---|---|
| builtin functions and unary `~` announcing non-null while returning NULL for a NULL or refused argument | `builtin-results-announce-honest-nullability` |
| scalar subqueries over a NOT NULL column that can find no row | `scalar-subquery-nullability` |
| a module holding NULL in a declared NOT NULL column (grandfathered rows) | `grandfathered-not-null-columns-read-as-nullable` |

Outer joins, which the original backlog ticket suspected, produced no violations: the null-extended side's columns are already widened.

## Design

In the egress row loop, for each column `i` with `columns[i].type.nullable === false`, a `null` cell throws, in the same form and through the same error path as an R1/R2 failure (name the column and say the announced type was NOT NULL). Precompute the indices of non-nullable columns once per execution, beside `reprTypes`, so the per-row cost is a loop over those indices only. Gate it on `REPR_STRICT` exactly like the existing check — no cost outside strict mode.

Then update:

- the comment block in `_iterateWithSignal` (it currently says this axis is unchecked and points at the backlog ticket);
- `docs/types.md` § Enforcement: replace the "further axis R2 does not cover … tracked as `backlog/debt-announced-nullability-disagrees-with-produced-nulls`" sentence with a statement that the seam also asserts the announced nullability, and what that means for a module or UDF author (a declared NOT NULL column or `*_RETURN_NOT_NULL` function that yields NULL fails strict-mode tests).

## Edge cases & interactions

- **Residual violations.** Run `yarn workspace @quereus/quereus test:repr-strict` (it uses `--bail`; for a full list run the mocha command directly without it: from the repo root, `QUEREUS_REPR_STRICT=1 node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" --reporter min`). Any violation left after the three prereqs is a new instance: fix its derivation in this ticket if it belongs to one of the three classes and the fix is local; otherwise file it (it is a defect, not a reason to weaken the check). Never exempt a column or skip a test.
- **Test-only modules and UDFs** that declare NOT NULL and return NULL fail the check. Fix the fixture's declaration (that is what the check is for).
- **Other packages.** `yarn test:repr-strict` exists only in `packages/quereus`; other workspaces are unaffected.
- **Multi-statement batches.** `columnDefCache` is per current statement; the check reads it exactly as the R1/R2 check does — no new handling.
- **Parameters / re-planning.** A re-plan clears `columnDefCache`, so the check always compares against the plan that produced the rows.

## Test

None new: the check is itself the net, run by `yarn check` through `test:repr-strict`. Confirm it fires by temporarily declaring a builtin non-null and seeing the suite fail, then revert.

## TODO

- Add the non-null check beside `assertRowConforms`, called from `_iterateWithSignal` under `REPR_STRICT`.
- Run the strict suite without `--bail`; resolve residual violations as described.
- Update the seam comment and `docs/types.md` § Enforcement.
- Run `yarn workspace @quereus/quereus test`, `test:repr-strict`, and `lint`.
