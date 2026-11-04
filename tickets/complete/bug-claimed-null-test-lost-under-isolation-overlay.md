description: When a storage module said it handled a filter the engine cannot turn into an index lookup, such as "is null" or "like", the engine dropped that filter, so a transaction's own uncommitted rows that failed it leaked into the answer. The engine now re-checks every such filter itself.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # the one behaviour change: holdsForEveryRow, reattachUnconsumedConstraints
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts           # comment only (named the deleted constant)
  - packages/quereus/src/vtab/best-access-plan.ts                          # BestAccessPlanRequest.limit doc only
  - packages/quereus/test/vtab/overclaiming-module.spec.ts                 # engine-level regressions and the exception pin
  - packages/quereus/test/vtab/redundant-constraints.spec.ts               # header comment only
  - packages/quereus-isolation/test/claimed-non-seek-filter.spec.ts        # end-to-end regression spec
  - docs/invariants.md                                                     # OPT-024, retitled; anchor changed
  - docs/optimizer.md                                                      # "The handledFilters contract"; link to the new anchor
  - docs/optimizer-retrieve.md                                             # Seek provenance intro and "Contents" bullet
  - docs/module-authoring.md                                               # "Claiming handledFilters"; one corollary reworded
  - docs/design-isolation-layer.md                                         # Index Scan Merge
repro: verified
----

Filed from the lamina board. Lamina works around this bug by not claiming the two null tests, which costs it LIMIT pushdown when one is present. Once a Quereus version with this fix is published, lamina can restore those claims after a version bump. Nothing was changed or run in lamina.

## What changed

`RECLAIMABLE_OPS` is deleted. `reattachUnconsumedConstraints` now puts back, as a `Filter` above the scan, every filter the module claimed and `rule-select-access-path` did not turn into a seek key or bound, whatever its operator. The one exception is `IS NOT NULL` on a column declared `NOT NULL`, which no row can fail (`holdsForEveryRow`). Memory claims exactly that, and its plans keep no extra `FILTER`.

A non-seek claim therefore never removes the filter. It still feeds the module's own pricing and counts toward the licence to stop at `request.limit`.

## Tests

| Test | Verifies |
| --- | --- |
| `overclaiming-module.spec.ts`, `non-seek claim: planner reattaches the filter it cannot consume` (3 cases) | OPT-024 for `is null`, `is not null` on a nullable column, and `like`, with no isolation |
| `claimed-non-seek-filter.spec.ts` (2 cases) | A staged row failing a claimed filter is removed: `is null` on a seek of another column, and `is not null` under `order by ... limit ... offset 0`. Each also checks the answer after commit |
| `overclaiming-module.spec.ts`, `non-seek claim: a tautological is not null is not reattached` | The `NOT NULL` exception |

## Review findings

Reviewed from the `ticket(implement): bug-claimed-null-test-lost-under-isolation-overlay` diff, then from the code around it.

**Validation.** `yarn lint` passes. `tsc -p packages/quereus-isolation/tsconfig.test.json --noEmit` is clean. `yarn test` exits 0: `packages/quereus` 10970 passing and 25 pending, `packages/quereus-isolation` 449 passing (one case cut, below), no failures in any workspace.

**Behaviour checked by running it.** A scratch script (not committed) compared 30 queries against a plain memory table holding the same rows. It ran them on a claiming module under isolation inside a transaction, on the claiming module alone, and on isolation over plain memory. The staged set included inserts, an update and a delete. All 30 answers matched. They covered:

- `is null`, `is not null`, `like`, `glob` and `not like`, with and without a seek on another column
- `limit` with an explicit `offset 0`, and `min` and `max` on a nullable column
- inner and left joins with the filter in `on` and in `where`
- correlated `like` in a join and in a scalar subquery, a parameterized `like`, and a `b in (select ...)` semi join
- `or` and subquery-source shapes

`update` and `delete` through a claimed filter inside the transaction, and the table after commit, also matched.

**Truncation, which the handoff left unverified.** A double that stops at `limit + offset` was run on `select min(a) from t` with the limit actually reaching it (`request.limit` = 1).
- A module that applies its claim returns the correct 30, with and without isolation. So the licence stays sound with the reattached `Filter` under the LIMIT, which is the shape lamina wants back.
- A module that claims the filter and does not apply it returns NULL alone, and 40 under isolation, where 30 is correct. This confirms what the docs now say. The same query with such a module was also wrong before this change, so it is not a regression. No action: the contract is documented in `optimizer.md`, `module-authoring.md` and the `request.limit` doc.
- `order by ... limit n offset 0` did not send a limit to the module in these runs. The isolation limit test therefore pins the `Filter` sitting below the `LimitOffset`, not the licence. The min/max boundary rewrite is the route that exercises the licence, as `bug-isolation-forwards-plan-time-limit-to-underlying` also records.

**Claims in the code and handoff, checked by reading or running.**
- A reattached filter cannot carry a subquery: the extractor accepts only a literal, parameter or column reference as a value, rejects `IN` with a subquery source, and rejects a promise-valued literal.
- `holdsForEveryRow`: inserting and updating a null into a `NOT NULL` column under isolation is rejected, and a tombstoned row never reaches the emitted stream.
- The `MATCH` tripwire is right: `src/parser` has no `MATCH` operator.
- The `monotonicOn` drop in `docs/optimizer-streaming.md` looks only at range and equality on the column, so a reattached non-seek filter does not trigger it.
- The store-backed suite was not run, and did not need to be for this change. The store claims only through `claimFirstPerRole`, whose roles are equality, `IN` and range, so it never claims a non-seek filter and `lost` is the same set for it before and after this change.

**Fixed in this pass (minor).**
- `overclaiming-module.spec.ts` header still said `FilterInfo.constraints` is the only place a claim is enforced; reworded to match the new contract.
- `redundant-constraints.spec.ts` header said only seek-family constraints are reattached; corrected.
- OPT-024's guard list omitted the exception pin; added.
- Cut the `like` case from `claimed-non-seek-filter.spec.ts`. It ran the same reattach path as the `is null` case beside it, and `like` stays pinned at engine level.

**Tripwires (conditional, parked in code).** A reattached `Filter` discounts `estimatedRows` again on top of the module's `rows`, which already priced the claim. Read from `FilterNode.estimatedRows`, not measured. `NOTE:` on `reattachUnconsumedConstraints`. The `MATCH` tripwire from implement stays there too.

**Major findings / new tickets: none.** Each concern below is already owned, so nothing was filed.
- Duplicate `FILTER, FILTER` when growth backs out on cost: `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter`. A residual `Filter` stacked over the reattached one gives correct answers and evaluates the same predicates, so it is not worth its own ticket.
- A shadowed committed row under a truncating module: `bug-isolation-forwards-plan-time-limit-to-underlying`.
- A seek argument taken from an unclaimed filter on a column with another claim: `bug-seek-argument-taken-from-constraint-module-did-not-handle`.

**Other angles.**
- Docs: read every file the diff touches, plus `optimizer-rules.md`, `optimizer-joins.md` and `optimizer-streaming.md`. Nothing else names the old rule or anchor.
- DRY: the six-line test double is written once per spec, because the two packages resolve the engine differently. Left as is.
- Resource cleanup and error handling: the change adds no resources or failure paths. `holdsForEveryRow` indexes `columns` by an index the extractor already validated.
- Performance: in-tree plans change only for a claim that was previously lost, and memory's tautology is exempt, so no in-tree query gains a `Filter`.
- File size: `rule-select-access-path.ts` is tracked by `debt-access-path-seek-selection-is-one-giant-function`; this change does not materially alter it.

**Not run.** Lamina's suite, which is out of this repo. The `Filter` preserves row order, so no effect on its ordering regression is expected, but that is reasoning, not a result.
