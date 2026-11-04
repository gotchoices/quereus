description: The engine's optional strict mode now checks the rows table-valued functions produce against their declared column types, so a function returning the wrong kind of value is reported at the function itself. The check exposed two functions breaking their declarations, and both are fixed.
prereq: bug-generate-series-yields-non-integers
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts   # the new check; run and runIntegrated merged into one generator
  - packages/quereus/test/runtime/representation-strict.spec.ts  # the seam test
  - packages/quereus/src/func/builtins/explain.ts                # query_plan est_rows declared REAL
  - packages/quereus/src/func/builtins/cardinality-feedback.ts   # NOTE on catalog_rows
  - packages/sample-plugins/comprehensive-demo/index.ts          # data_summary yields text for its counts
  - packages/quereus/src/runtime/strict-flags.ts                 # seam list comment
  - packages/quereus/src/runtime/strict-representation.ts        # header comment
  - packages/quereus/src/core/statement.ts                       # egress seam comment
  - docs/types.md                                                # § Enforcement, seam table, known gaps
  - docs/runtime.md                                              # strict harness section
  - docs/plugins.md                                              # the contract for table-valued function rows
----

`QUEREUS_REPR_STRICT` now has a fifth check point. With the flag on, each row a table-valued function yields is checked against its declared column types after row-width normalization. A violation throws `RepresentationError` naming the function, column and declared type, for example: `the row yielded by table-valued function bad_series(0) column 0 (value): declared type INTEGER admits ...`. The number in parentheses is the argument count, matching the scalar function check. With the flag off, the row loop gains one already-false branch and emit builds nothing for the check.

## What changed

**The check.** `run` and `runIntegrated` in `emitTableValuedFunctionCall` were copies of the same loop, so they are now one generator that picks the calling convention once per call. The surrounding `catch` rethrows `RepresentationError` unchanged, so a violation is not re-reported as `Table-valued function X failed: ...`.

**Violations found and fixed.**

- `data_summary` (sample plugin): the `value` column is TEXT, but the `length` and `key_count` rows yielded numbers. The values now go through `String(...)`.
- `query_plan`: `est_rows` was declared INTEGER, but a five-way cross join of analyzed 2000-row tables estimates 3.2e16, a whole JS `number` past 2^53, which INTEGER does not admit. It is now declared REAL, matching `est_cost`. Runtime values are unchanged; the type announced through `getColumnDefs()` changes from INTEGER to REAL.

**Behaviour worth knowing.**

- A function that declares no columns (`split_string`) gets rule R1 only, not a full skip.
- The `json_each` / `json_tree` argument-count check now also applies to an integrated function registered under one of those names. No in-tree function is one.

## Review findings

Reviewed from the `ticket(implement): tvf-output-representation-check` diff, before reading the handoff.

**Checked by running.** A throwaway spec, since deleted, ran under `QUEREUS_REPR_STRICT=1`:

- Every registered built-in table-valued function on a populated schema with a foreign key, check, unique constraint, partial index, view and assertion, including the error-row branches of the diagnostic functions: no violations. `cardinality_feedback()` returned no rows in that probe, so its columns were covered only by the suite's own `cardinality-feedback.spec.ts`.
- A no-column function yielding a small `bigint` throws under R1. A cell truncated by normalization is not judged, and a short row pads with null without a violation.
- An integrated function receives the database and is checked.
- The error class and message survive constant folding, a join, a scalar subquery, `exists`, a CTE, `insert ... select` and a lateral join.
- A thrown non-representation error is still wrapped as `Table-valued function X failed:`, and the implementation's `finally` runs when a violation ends the loop.

**Checked by reading.** All declarations against their yields: `explain.ts`, `schema.ts`, `json-tvf.ts`, `string.ts`, `cardinality-feedback.ts`, `basis-lifecycle-tvf.ts` and both sample plugins. `generate_series`'s row estimate is always a `number`, so moving `est_rows` to REAL, which does not admit `bigint`, opens no new violation. `reportedRowCount` already rejects non-integer `getRowCount` answers, which narrows the handoff's concern about `baseline_rows`. `data_summary` and `quereus_basis_lifecycle` were not re-run in this pass; the implementer's runs stand for those.

**Validation after the fixes below.** `yarn workspace @quereus/quereus lint` exit 0; `test:repr-strict` 10995 passing, 16 pending; `test` 10985 passing, 26 pending; `yarn docs:check` passes (the `docs/invariants.md` failure in the handoff was resolved by the triage commit). The two test runs preceded the final `docs/types.md` bullet, which is prose only; `docs:check` was re-run after it. Not run, since the review changed only comments and docs: full `yarn build`, `yarn typecheck`, `yarn bench:gate`, `test:store` under the flag, and the `@quereus/sync` and `@quereus/sample-plugins` suites.

**Minor, fixed in this pass.**

- Stale wording the implementer's seam update missed: "the four runtime seams" in `test/property.spec.ts`, and "two boundaries" in `runtime/emit/scalar-function.ts` and `src/index.ts`. `util/numeric-canonical.ts` also now names table-valued function rows.
- Reflowed the long line in `docs/types.md` § Enforcement and the broken comment in `runtime/strict-flags.ts`.
- `docs/types.md` known gaps was missing that `yarn check` runs this mode over `packages/quereus` only, so the sync and sample-plugin functions are checked only when someone sets the flag by hand. Added.

**Major:** none. No tickets filed.

**Tripwires.**

- `catalog_rows` and `baseline_rows`: a module whose `getStatistics` reports a fractional row count would trip the INTEGER declaration, because that path is not validated the way `getRowCount` is. Parked as a `NOTE:` in `func/builtins/cardinality-feedback.ts`.

**Noticed, no action.** `schemaSizeFunc` in `explain.ts` is declared and exported but unregistered, with an empty body and a `TODO`; calling `schema_size()` reports function not found. It predates this ticket and nothing reaches it, so the check does not apply.

**Tests.** The implementer's seam test stays: it pins the error class, the naming and the absence of rewrapping, and the implementer reports it failed against both mutations. It was not re-mutated in this pass. No tests added: the no-column R1 path is one branch of `assertRowConforms`, already covered directly in the same spec, and the probe confirmed it end to end. The two declaration and value fixes also have no regression test, a call accepted here because one is a declaration and the other a one-line sample change. `data_summary` therefore remains uncovered by any suite.

**Considered-and-declined:** none; no accepted-tradeoff `NOTE:` sits at these sites.

**Other categories.** Performance: the flag-off cost is one const-guarded branch per row by reading; not benchmarked, and `bench:gate` was not run. Resource cleanup: covered by the `finally` check above. Type safety: the merge removed two non-null assertions, and `implementation` is non-optional in the schema. File size: the emitter shrank.
