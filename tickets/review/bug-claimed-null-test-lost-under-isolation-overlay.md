description: When a storage module said it handled a filter the engine cannot turn into an index lookup, such as "is null" or "like", the engine dropped that filter, so a transaction's own uncommitted rows that failed it leaked into the answer. The engine now re-checks every such filter itself.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # the one behaviour change: holdsForEveryRow, reattachUnconsumedConstraints
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts           # comment only (named the deleted constant)
  - packages/quereus/src/vtab/best-access-plan.ts                          # BestAccessPlanRequest.limit doc only
  - packages/quereus/test/vtab/overclaiming-module.spec.ts                 # engine-level regressions and the exception pin
  - packages/quereus-isolation/test/claimed-non-seek-filter.spec.ts        # new end-to-end regression spec
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

## Use cases to validate

All of these run against a module that claims `IS NULL`, `IS NOT NULL` and `LIKE` on top of memory's own claims.

- Inside a transaction, `a is null and b = 5` (a seek on another column) does not return a staged row with non-null `a`. The same holds for `s like 'a%' and b = 5`.
- Inside a transaction, `a is not null order by id limit 2 offset 0` skips a staged row with null `a` and still returns two rows.
- Each of those answers is unchanged after commit.
- With no isolation at all, the same claims return the right rows.
- `select min(a) from t where a is not null` on a `NOT NULL` column plans with no `FILTER` on memory.

## Tests added

| Test | Verifies | Without the fix |
| --- | --- | --- |
| `overclaiming-module.spec.ts`, `non-seek claim: planner reattaches the filter it cannot consume` (3 cases) | OPT-024 for `is null`, `is not null` and `like`, with no isolation | All 3 failed, returning `[1, 3]` |
| `claimed-non-seek-filter.spec.ts` (3 cases) | A staged row failing a claimed filter is removed: `is null` and `like` on a seek of another column, and `is not null` under `order by ... limit ... offset 0`. Each also checks the answer after commit | All 3 failed inside the transaction |
| `overclaiming-module.spec.ts`, `non-seek claim: a tautological is not null is not reattached` | The `NOT NULL` exception | Passes at HEAD by design. With the exception disabled for one run it failed with one `FILTER`, so the pin works |

## Validation run

- `yarn build`: passes.
- `yarn lint`: passes, including the test-file type pass in `packages/quereus`.
- `yarn test`: exit 0, no failures. `packages/quereus` 10970 passing and 25 pending; `packages/quereus-isolation` 450 passing.
- `tsc -p packages/quereus-isolation/tsconfig.test.json --noEmit`: clean.

## Known gaps

- **Store-backed suite not run** (`yarn test:store`). A search of `packages/quereus-store/src` found no reference to `IS NULL`, `IS NOT NULL` or `LIKE`, so the store should claim none of them and I expect no change there. That is reasoning from a search, not a test result.
- **Lamina's suite not run.** The code comment in `rule-grow-retrieve` names it as the home of one end-to-end ordering regression. This change adds a `Filter`, which preserves row order, so I do not expect an effect.
- **Duplicate `FILTER` on the backed-out path.** When growth backs out on cost, the pipeline's `Filter` is kept and the reattached one is stacked on it, giving `FILTER, FILTER, INDEXSCAN`. The answer is correct and the cost is one extra predicate evaluation per row. This is owned by `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter` in `backlog/`, which already lists this instance, so it was not fixed here. I did not re-measure this shape.
- **Under-production for a false claim under a LIMIT is unverified.** A module that claims a filter it does not apply and also stops at `limit + offset` returns too few rows, because the reattached `Filter` discards rows the module counted. This follows from reading `truncationIsSafe`; no test demonstrates it, because the test double extends memory, which ignores `request.limit`. The same hazard already applied to seek-family over-claims. I corrected the docs that said an over-claim never costs a wrong answer, and added it to the `request.limit` doc. The after-commit assertion in the limit test depends on memory continuing to ignore the limit; the spec header says so.
- **The test double is written twice,** once in each spec, because the packages resolve the engine differently (`src` in one, `dist` in the other). It is six lines. Say so if you would rather share it.
- **The plan shape of the leak cases is not pinned,** only their rows. I did not want the tests to depend on whether growth backs out on cost.

## For the reviewer

- Work beyond the ticket's list: the `request.limit` doc in `best-access-plan.ts`, the `Seek provenance` opening sentence in `optimizer-retrieve.md` (it said every claimed predicate is folded into seek keys), and the corollary in `module-authoring.md` now reads "Claim a seek-family filter only if you can seek it", because "only claim what you can seek" contradicted claiming a null test at all.
- OPT-024's title and anchor changed. `docs/optimizer.md` and `docs/design-isolation-layer.md` link the new anchor, and a search of `docs`, package sources and open tickets found no other link to the old one.
- A reattached filter cannot carry a subquery: the extractor only accepts a literal, parameter or column reference as a constraint's value, so the "unphysicalized subquery" failure mode of residuals does not apply here. Worth a second look.
- `MATCH` tripwire is a `NOTE:` on `reattachUnconsumedConstraints`.
