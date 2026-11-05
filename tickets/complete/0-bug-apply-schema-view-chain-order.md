description: When a schema migration replaced views built on other views, it dropped and created them in an order that ignored those dependencies, so a failed migration could lose the views and some migrations could never apply. Views are now dropped and created in dependency order, so the rollback restores them and those migrations apply.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/schema/schema-differ.ts # MigrationCreate.viewReach, viewCreate, withViewsReached, ViewBodies, orderViewDropsDependentsFirst, followDeclaredViewsInAddedColumnReads, viewStageTwoItems, pushCreate
  - packages/quereus/test/apply-schema-restore.spec.ts # describe 'views built on other views'
  - docs/schema-declarative.md # MigrationCreate, Migration Order steps 2 and 4.2
  - docs/schema-undo-plan.md # Restoring a failed apply
  - docs/sql-ddl.md # one sentence on what a new view can read
repro: verified
----

Reported in GitHub issue #39. The sibling ticket `bug-apply-schema-redefine-view-a-rule-reads` depends on this one and reuses `withViewsReached`.

## What changed

**Drops.** `computeSchemaDiff` sorts `diff.viewsToDrop` with `orderDependentsFirst`, so a view is dropped ahead of every view it reaches through the pre-apply catalog's view bodies, including through a view the plan does not touch. The undo journal runs in exact reverse and each undo is a `create view` that plans its body, so the reversed order brings back each reached view first. `runJournalInReverse` did not change.

**Creates.** Each view create carries `MigrationCreate.viewReach`: the names its body names, plus the views reached from them through declared view bodies. The walk runs in `computeSchemaDiff` because `generateMigrationPlan` has no catalog for `diff schema`. `viewStageTwoItems` uses `create.viewReach ?? named` for `runsAfter`, so a hand-built diff without the field keeps the old behaviour.

**Shared walk.** `withViewsReached(names, viewBodies, schemaName)` was extracted from `followDeclaredViewsInAddedColumnReads`. It takes a `ViewBodies` map, so one walk serves both the declared bodies and the catalog bodies.

## Tests

Three spec tests in `test/apply-schema-restore.spec.ts`, under `views built on other views`, one for each reported scenario: a redefined chain restores, a chain through an untouched view restores, and a new view applies when it reads a later-written view through an untouched view.

## Review findings

**Read first:** the diff of `ticket(implement): bug-apply-schema-view-chain-order`, then `dependency-order.ts`, `objectsNamedIn`, `UndoRenderer.recreateView`, the plan's drop and create phases, and every `viewsToDrop` consumer.

**Major, recorded on an existing ticket: a chain through another schema still loses the views.** The walk sees only the schema being applied, because the differ's catalog and declaration hold no other schema. With `s.V3` over `main.M` over `s.V1`, redefining `V1` and `V3` plus a later failing step ends in "could not be restored" (`Table not found: s.V1`), with both views gone. Run against the built package. The fix belongs in the rollback's validation of a recreated view, so the case went as a new arm on `bug-apply-undo-refused-when-recreated-object-does-not-validate`, not a new ticket. Passing other schemas' bodies to the differ would fix only this one shape.

**Tripwire: the forward side of the same chain.** Declaring `s.V3` before `s.V1` fails with `Table not found: s.V1`, and the catalog is restored correctly. Writing `V1` first avoids it. This falls short of the "any order" statement in `docs/sql-ddl.md` only for a chain that leaves the schema and comes back. Parked as a `NOTE:` on `withViewsReached`, and stated as a limit in `docs/schema-declarative.md` § Migration Order, which `sql-ddl.md` already points to for known limits.

**Minor, fixed in this pass:**

- `viewReach` leaked onto plan steps, because `pushCreate` passed or spread the create. `pushCreate` now builds the step from `sql` and `ast`, the same way the re-attach step does. `MigrationStep` does not declare the field, so nothing can read it from a step.
- `docs/schema-declarative.md` described `MigrationCreate` without `viewReach`. Fixed.
- `docs/schema-declarative.md` and `docs/schema-undo-plan.md` stated the view ordering without the single-schema limit. Fixed.

**Implementer's open gaps, now settled:**

- Maintained tables between views: confirmed by running it, where the handoff had only read the code. `V3` over maintained `M` over `V1`, with `V1` and `V3` redefined and a failing later step, restores. No ordering is needed through a maintained table.
- Unrelated views moving when a dependency exists (`[a, b, c]` becoming `b, c, a`): accepted. It only affects the order of drops that do not depend on each other, and the docs promise stable order only for plans with no dependency.
- Tables reached through views as a weak preference: the existing `NOTE:` on `viewStageTwoItems` stands. Nothing reproduces it, so it stays a tripwire.
- Walk cost: the `NOTE:` at `orderViewDropsDependentsFirst` stands. Not measured here either. The sort makes no edges and returns its input when no dropped view reaches another.

**Checked, no defect:**

- Body forms: an 11-case probe of scalar subquery, `exists`, `in`, join, `union all`, CTE, derived table, `order by` subquery, `main.`-qualified name, differently cased name, and a `with defaults` subquery. Each dropped `V2` first and restored.
- Table rename plus a redefined chain, with a failing later step: restored.
- Both views of a chain removed, with a failing later step: `v2` drops first and the catalog is restored.
- Self-edges: `withViewsReached` includes the view's own name, and `resolveEdges` ignores a dependency on the item itself. A catalog cycle cannot hang the sort, because `orderDependenciesFirst` breaks cycles.
- Case handling: `viewsToDrop` can hold original-case names, and the sort's key function lowercases them to match the walk's lowercased names.
- No later push to `viewsToDrop` follows the sort. The later readers (`enforceRequireHint`, `droppedInThisDiff`) do not depend on order.

**Tests:** kept all three. Each pins a reported scenario through the real apply path. A mutation check that removed the drop sort and the `viewReach` edge made all three fail, with `could not be restored` on the first two and `Table 'V1' not found` on the third. No test added: the fixes above are a step's shape and docs, and the cross-schema arm is tracked on the ticket that owns it. None cut.

**Source hygiene:** `schema-differ.ts` is 4,149 lines by `wc -l`, about 150 more than the 3,991 recorded on 2026-11-03. The split is already tracked by `debt-oversized-source-files`, so nothing new was filed.

**Validation:** `yarn build`, `yarn lint` and `yarn test` all exit 0 after the review edits. `yarn test:store` was not run: the changes are in plan ordering and step shape, not in a storage path. The undo statements themselves did not change.
