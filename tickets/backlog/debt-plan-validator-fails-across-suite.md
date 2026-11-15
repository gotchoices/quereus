description: The optional plan-checking mode, which looks for internal inconsistencies in query plans, rejects plans in several hundred existing tests, so it cannot be turned on to catch new planner bugs. Sort out which rejections are real planner defects and which are wrong checks, so the mode can run in the test suite.
architecture: docs/optimizer.md#attribute-provenance
files: packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/src/planner/optimizer-tuning.ts (debug.validatePlan default), packages/quereus/src/planner/optimizer.ts (validatePhysicalTree call), packages/quereus/src/core/database.ts (validate_plan option)
tradeoffs: The checks only run when a developer turns them on, so nothing a user sees changes until one of the rejected shapes turns out to be a real wrong-result bug; sorting 388 failures across several node families is a lot of work for a debugging aid.
----
# The plan validator rejects plans across the existing suite

`validatePhysicalTree` (run when `tuning.debug.validatePlan` is true, which the `validate_plan` option sets) checks a finished plan: every attribute id is originated by one node (invariant OPT-014 in `docs/invariants.md`), every column reference resolves to an id in the tree, no logical-only node survives into the physical plan, and every attribute names its source relation. It is off by default and the test runner does not turn it on, so nothing keeps the planner consistent with it.

## Measurement

Measured on 2026-11-14 while working `bug-join-over-union-reads-first-legs-repeated-column`. Temporarily set `debug.validatePlan: true` in `packages/quereus/src/planner/optimizer-tuning.ts` (that default is what the optimizer reads; flipping the option's default in `database.ts` was not tried), then from the repo root:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" --reporter min
```

Result: 10751 passing, 388 failing. The same 388 failure messages appeared with that ticket's changes disabled, so they predate it. Counts by message, from grepping the failure lines (one sqllogic file stops at its first failure, so later statements in a failing file were never checked, and the true number of rejected plans is higher):

- `ColumnReference refers to unknown attribute ID` — 93 (seen under `Sort > Project`, `ViewMutation > Project`, `AlterTable` defaults, and plain `BinaryOp` expression trees validated on their own).
- `Attribute ID … originated at two distinct nodes` — 76. Paths include `ViewMutation > Sink > UpdateExecutor > ConstraintCheck > Insert > Project > Envelope…`, `CTE > Returning > UpdateExecutor > … > TableLiteral` reached through two `CTEReference`s, and `Join > CTEReference > RecursiveCTE > TableLiteral`.
- `Logical-only node type Aggregate found in physical tree` — 27.
- `Attribute … has invalid source relation "undefined"` — about 40 (under `Sort`, `Filter`, `Join`, `SetOperation`, `StreamAggregate`).
- The rest are tests that assert on a specific error message or plan shape and got the validator's error instead, plus 15 property-based (fast-check) failures.

## Expected outcome

Each category is either fixed at the node that produces it (when it is a real inconsistency, for example two nodes really minting one id) or the check is narrowed with a `NOTE:` saying why the shape is legitimate. Once the suite passes with the validator on, consider running it in the default test run so planner changes are checked against OPT-014 automatically.

The "two distinct nodes" group deserves the first look: a shared id between two nodes that each produce rows is the same class of defect as the union bug that prompted this measurement (two columns bound to one row slot), and may give wrong results somewhere.
