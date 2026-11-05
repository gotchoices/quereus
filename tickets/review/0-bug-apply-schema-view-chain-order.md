description: When a schema migration replaced views built on other views, it dropped and created them in an order that ignored those dependencies, so a failed migration could lose the views and some migrations could never apply. Views are now dropped and created in dependency order, so the rollback restores them and those migrations apply.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/schema/schema-differ.ts # MigrationCreate.viewReach, viewCreate, withViewsReached, ViewBodies, orderViewDropsDependentsFirst, followDeclaredViewsInAddedColumnReads, viewStageTwoItems
  - packages/quereus/test/apply-schema-restore.spec.ts # describe 'views built on other views'
  - docs/schema-declarative.md # Migration Order, steps 2 and 4.2
  - docs/schema-undo-plan.md # Restoring a failed apply
  - docs/sql-ddl.md # one sentence on what a new view can read
repro: verified
----

Reported in GitHub issue #39. The sibling ticket `bug-apply-schema-redefine-view-a-rule-reads` depends on this one and reuses `withViewsReached`.

## What changed

**Drops.** `computeSchemaDiff` now sorts `diff.viewsToDrop` with `orderDependentsFirst`, so a view is dropped ahead of every view it reaches through the pre-apply catalog's view bodies, including through a view the plan does not touch. The undo journal runs in exact reverse and each undo is a `create view` that plans its body, so the reversed order brings back each reached view first. `runJournalInReverse` did not change.

**Creates.** Each view create now carries `MigrationCreate.viewReach`: the names its body names, plus the views reached from them through declared view bodies. The walk has to run in `computeSchemaDiff` because `generateMigrationPlan` has no catalog for `diff schema`. `viewStageTwoItems` uses `create.viewReach ?? named` for `runsAfter`, so a hand-built diff without the field keeps the old behaviour. The ticket suggested `[...named, ...viewReach]`, but `viewReach` already contains `named`.

**Shared walk.** `withViewsReached(names, viewBodies, schemaName)` was extracted from `followDeclaredViewsInAddedColumnReads`. It takes a `ViewBodies` map, so one walk serves both the declared bodies and the catalog bodies. A view with no body (a hand-built catalog) can be reached, but nothing is reached through it.

## Tests added

All are in `test/apply-schema-restore.spec.ts`, under `views built on other views`. All three failed before the fix, with the errors the ticket describes.

- `restores a chain of views both redefined, written in the order they read each other`: scenario 1. The step's own error comes back unwrapped, the strict catalog fingerprint is unchanged, and `V2` returns its old result.
- `restores a chain through a view the plan leaves alone`: scenario 2. Same assertions, through the untouched view `M`.
- `creates a view after a new view it reads through a view the plan leaves alone, whichever is written first`: scenario 3. The apply succeeds, re-diffs empty, and `V3` returns the new result.

## Validation

`yarn build`, `yarn test` and `yarn lint` all exit 0, with no failing test in any package. `yarn test:store` was not run: the change is in the planner, which does not depend on the storage module, and the new tests are spec tests on a memory-backed module.

Checked with a throwaway script against the built package, not kept as tests:

- Five unrelated views (three redefined, two removed) keep the present order: declared first in declaration order, then removed in catalog order.
- Both views of a chain removed from the declaration: `v2` drops before `v1`.
- A removed view reading a redefined view drops first.
- A hinted view rename inside a chain drops old names dependents first, creates `V1b` before `V2`, and re-diffs empty.
- A view whose CTE shadows a view's name gets no edge, so declaration order holds.
- A chain in a non-main schema with a failing `ADD COLUMN` restores: the old `V2` result comes back.
- A new view reading through an unchanged view and an altered table applies and re-diffs empty.

## Known gaps and things to look at

- **Unrelated views can still move when a dependency exists.** With `[a, b, c]` where `c` reaches `a`, the result is `b, c, a`. Some unrelated pair has to flip in any valid order here, but `a` and `b` do swap, so `diff schema` output can shift beyond the two related views. Only a plan with no dependency among its dropped views is guaranteed to keep its order. The docs say so.
- **Tables reached through views are still only a weak preference.** `viewReach` carries views, and `prefersToRunAfter` still uses only directly named tables. The existing `NOTE:` on `viewStageTwoItems` named `viewReach`-style carrying as its remedy, so I reworded it to name what is left: keep the tables the walk passes and put them in `prefersToRunAfter`. I did not build this because nothing reproduces it yet.
- **`viewReach` also ends up on plan steps.** `pushCreate` passes or spreads the create into the step, so a view step carries a planner-only field. Nothing reads it there and no test objects, but it is visible to anyone inspecting a plan.
- **Maintained tables are not walked.** A view reading a maintained table is not followed through the maintained table's body, because `create view` treats it as a table. This comes from reading the code; I did not run it.
- **Walk cost.** The drop sort does one AST walk per reached view per dropped view. There is a `NOTE:` at `orderViewDropsDependentsFirst`. I did not measure it.
