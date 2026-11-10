description: When the row limit of a sorted query is a placeholder filled in at run time ("order by date limit ?", the usual paginated list), plan both the index read and the scan-and-sort, and pick between them each time the query runs once the actual limit is known.
prereq: sort-absorb-sees-constant-limit
architecture: docs/optimizer-retrieve.md#constraint-sweep-scope
difficulty: hard
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # the LimitOffset arm added by the prereq; trySortAbsorbViaIndexOrdering; probeAccessPlan; planDeliversOrdering
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts  # safeToEvaluateTwice — move to rules/shared/ and reuse
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts  # precedent: a node holding the LimitOffset's own limit/offset expressions as extra children
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts  # precedent: run-time decision from resolveWindow
  - packages/quereus/src/runtime/emit/limit-offset.ts  # resolveWindow
  - packages/quereus/src/runtime/emit/join.ts  # emitCallFromPlan on a relational child: on-demand, unchosen branch never opens
  - packages/quereus/src/planner/nodes/plan-node-type.ts  # new node type
  - packages/quereus/src/runtime/register.ts  # emitter registration
  - packages/quereus/src/planner/analysis/required-columns.ts  # must pass requirements to both branches
  - packages/quereus/src/planner/validation/plan-validator.ts  # validateCostAdditivity (strict: total = self + every child)
  - packages/quereus-store/src/common/store-module-access-plan.ts  # NOTE on chooseOrderingPlan (~:1191)
  - packages/quereus-store/test/plan-time-limit.spec.ts  # IndexedDB-profile end-to-end cases
  - docs/optimizer-retrieve.md
  - docs/module-authoring.md  # ~:185 probe list, ~:193 the limit licence
----
# A placeholder LIMIT above a Sort: decide at run time

## Background

After `sort-absorb-sees-constant-limit`, `ruleGrowRetrieve`'s LimitOffset arm sends a constant `limit` / `offset` to the module through `trySortAbsorbViaIndexOrdering(sort, ctx, rowsWanted)`, and an expensive-`pointRead` backend (IndexedDB) then picks the bounded index read over scan-then-sort. When either expression is not a constant, that arm returns null, and `select * from t where owner = ? order by date desc limit ?` (GitHub #36, the paginated-list query) is still planned as if it read every row of the owner.

Maintainer decision (2026-11-10): handle a placeholder limit the way `bug-parameterized-limit-reads-every-key` did for the key-set semi join. Decide seek versus walk **at run time from the actual value**, instead of giving up when the limit is not a literal.

## Why a two-branch node

The two candidates differ in both the access path and whether a Sort exists:

- **ordered**: the absorbed subtree. A Retrieve with an index-style context whose plan provides the ordering, no Sort, and it stops once the LimitOffset stops pulling;
- **sorted**: the original `Sort` over the original subtree, which reads every row.

No single access leaf can switch between these. The key-set node's trick of overriding the leaf's `FilterInfo` at run time does not reach a Sort above the leaf, and the two plans leave different residual predicates. So the rule builds a node holding both and the emitter runs one per execution.

## Design

### Where the threshold comes from

The module is the authority on which plan is cheaper. The only question is up to what row count it still prefers the ordered plan. Find that with plan-time probes; `getBestAccessPlan` is pure at plan time.

Let `orderedAt(L)` be: run `probeAccessPlan` with `limit: L, offset: 0` on the request `trySortAbsorbViaIndexOrdering` builds, and return the plan if `planDeliversOrdering` holds, else undefined. `probeAccessPlan` already strips an unsafe limit, so an unsafe subtree gives undefined at every `L`.

1. If the limit-free probe already delivers the ordering, return null and let the Sort visit absorb it as it does today. Parity backends land here, so their plans do not change.
2. If `orderedAt(1)` is undefined, decline. No limit makes the index read worth it.
3. Exponential search `L = 2, 4, 8, …` until `orderedAt(L)` is undefined or `L` reaches a cap (`2 ** 30`). Then binary-search between the last delivering value and the first failing one. Call the largest delivering value `orderedUpTo` and keep the plan it returned. Under the store's pricing the ordered cost rises with `L` and the scan's does not, so the answer is monotone. A non-monotone module only gets a worse threshold, never a wrong answer, because both branches return the same rows.

The probe count is about `2·log2(table rows) + 2`, around 40 for a million rows. Record that as a `NOTE:` at the search (tripwire: if a module's `getBestAccessPlan` is expensive enough to show up at prepare time, memoize per table per pass or lower the precision). Add one line to the probe list in `docs/module-authoring.md` (~:185) saying a placeholder limit triggers this search.

**Why the plan at `orderedUpTo`**: it is the cheapest ordered plan at the boundary, where picking the wrong ordered plan would cost the most. Below the boundary every ordered plan is cheap.

**Soundness of the licence**: the ordered plan was requested with `limit: orderedUpTo, offset: 0`. A module may truncate to that. The emitter runs the ordered branch only when the actual `limit + offset ≤ orderedUpTo`, so a truncating module never underproduces. State this invariant at the emitter's comparison and in `docs/module-authoring.md` near "`limit` is a licence": a placeholder LIMIT reaches the module as the largest bound the engine will ever run that plan under.

### Refactor `trySortAbsorbViaIndexOrdering`

Split it so the probe can be repeated without rebuilding the tree. For example, `prepareSortAbsorb(sort)` returns `{ chain, retrieveNode, request, constraints, requiredOrdering, tableSchema, ask }` or null, and `buildAbsorbed(prepared, accessPlan)` builds the equipped Retrieve plus the rebuilt chain, exactly as the tail of the function does now. Keep `trySortAbsorbViaIndexOrdering` as the composition of the two, so its two existing callers do not change. It must stay side-effect free (see its doc comment).

### The node

Add a new relational node, for example `LimitChoiceNode` (`PlanNodeType.LimitChoice`), in `planner/nodes/`:

- children `[ordered, sorted, limit, offset?]`. `limit` and `offset` are the **same expression instances** as the LimitOffset above, which is the `KeySetSemiJoinNode.rowBound` precedent. `getRelations()` returns both branches;
- `orderedUpTo: number`;
- attributes, type, ordering, `estimatedRows` and physical properties taken from `sorted`. The constructor and `withChildren` assert that `ordered.getAttributes()` matches `sorted.getAttributes()` position by position by attribute id, and throw `INTERNAL` otherwise. Both branches come from one subtree, so they match by construction. The check catches a later rewrite that changes only one branch;
- self-cost small (like LimitOffset's `0.01`). Cost additivity is strict (`validateCostAdditivity`: total = self + every child), so the node's total counts **both** branches, roughly twice today's plan, because the ordered branch at `orderedUpTo` costs about as much as the sorted one. Accept that and leave a `NOTE:` on the node: the node usually sits directly under a top-level LimitOffset where nothing compares its cost; if it is ever seen distorting a join order (inside a derived-table join leaf), give the framework a way for a node to count one alternative;
- the display shows `orderedUpTo`, so `query_plan` reads as "ordered when limit + offset ≤ N".

Register an emitter in `runtime/register.ts`. Make sure the plan validator and `analysis/required-columns.ts` handle the new type: the columns needed above are needed from **both** branches.

### The rule

Fill the non-constant branch of the prereq's LimitOffset arm:

- decline unless `limit` is present and both `limit` and `offset` pass `safeToEvaluateTwice`. Move that helper out of `rule-key-set-seek-row-bound.ts` into `rules/shared/` and import it from both rules. A correlated limit is admitted, as it is there;
- decline when the subtree below the Sort has side effects (`PlanNodeCharacteristics.subtreeHasSideEffects`) or any scalar in it has a relational descendant (`hasRelationalDescendant`, a subquery). Both branches share those nodes, and a subquery body hanging off a shared predicate is not worth the risk. Declining only costs reads;
- run the search above. On success build `LimitChoice(ordered = buildAbsorbed(prepared, planAtOrderedUpTo), sorted = sort, limit, offset)`, put it in the Sort's place with `rebuildChain`, and return the new LimitOffset.

The pass memoizes optimized nodes by original id (`optimizedNodes` in `framework/pass.ts`), so a node shared between the branches is rewritten the same way in both. Later visits are expected and harmless: the Sort inside `sorted` gets offered `grow-retrieve-Sort` and declines, since the limit-free probe does not deliver the ordering. A Filter in `ordered` re-growing into the equipped Retrieve is held by the existing no-clobber guard in `fallbackIndexSupports`.

### The emitter

Emit both branches with `emitCallFromPlan`, so each is an on-demand callback as in `join.ts` and the unchosen branch never opens a cursor. Emit the limit/offset as callbacks too. Per execution: `const { limit, offset } = await resolveWindow(rctx, limitFn, offsetFn)`. If `limit + offset <= plan.orderedUpTo`, stream `ordered`, else stream `sorted`. `limit 0` takes `ordered`. The LimitOffset above evaluates the same expressions before opening its source, so an invalid value (NULL, negative) has already thrown there. `resolveWindow` uses the same `toRowCount`, so the two cannot disagree.

### Comments and docs

Update again the comments the prereq touched (`trySortAbsorbViaIndexOrdering`'s doc comment, the minmax rule comment, the `chooseOrderingPlan` `NOTE:`) so none of them says a placeholder limit is invisible. In `docs/optimizer-retrieve.md`, add a short subsection describing the node, the threshold search and the licence invariant.

## Edge cases & interactions

- **Literal limit, placeholder offset** (`limit 20 offset ?`, pagination): non-constant, so it takes this path, and the run-time comparison uses `limit + offset`. Covered by the end-to-end test if it is cheap to add as a second statement; otherwise by inspection.
- **Unclaimed filter below the Sort**: `orderedAt(1)` is undefined and the rule declines. Today's plan stays. By inspection (the `truncationIsSafe` specs pin the probe).
- **Parity backend**: step 1 returns null and the plan is unchanged. Covered by the existing suites staying green.
- **Re-binding a prepared statement**: one plan, a different branch per execution. This is the main test.
- **Correlated limit** (`limit o.n` inside a lateral or correlated subquery): both evaluations read the same outer row, as in the key-set node. By inspection, citing that precedent.
- **Writing or non-deterministic limit expression**: declined by `safeToEvaluateTwice`. By inspection.
- **Unchosen branch opens nothing**: required for correctness of work counters and for cost. Asserted by the test's read counts (a scan of the sorted branch would show up as `rowsScanned` near the table size).
- **Rules that look under a LimitOffset** (`rule-monotonic-limit-pushdown`, `rule-fanout-lookup-join`, `rule-join-elimination`, `rule-key-set-seek-row-bound`) do not see through the new node. They lose nothing: the node exists only when the limit-free plan is not ordered on the sort key, which `monotonic-limit-pushdown` needs, and the absorb's chain (Project/Filter/Alias down to a Retrieve) cannot contain a key-set join. By inspection; note it in the node's doc comment.
- **Rewrites that change one branch's columns** (projection pruning, required-columns): caught by the attribute assertion in `withChildren`. The full quereus suite running green is the check.
- **Cost over-count**: accepted, `NOTE:` as above.
- **Isolation layer**: the ordered branch's request carries `limit: orderedUpTo`, which, like every forwarded limit, is subject to backlog `bug-isolation-forwards-plan-time-limit-to-underlying`. Out of scope.

## Tests

In `packages/quereus-store/test/plan-time-limit.spec.ts`, IndexedDB profile, `ix_bc on t(b, c)` (the #36 `(owner, date)` shape). Use `descC` and `order by c desc` if the descending spelling goes through the same path; the "latest N" query is what the maintainer asked to see.

- Prepare `select * from t where b = 1 order by c desc limit ?` once. `query_plan` shows the new node. Run it with `? = 20`: the rows equal a reference (the parity-profile result, or a sort done in the test), and `stmt.getWorkCounters().rowsScanned` (as used in `test/vtab/key-set-semi-join-runtime.spec.ts`) is about 20, not the owner's row count. Run the same prepared statement with a limit above the threshold (larger than the owner's row count): same rows as the reference, sorted branch taken. This one test is the reproduction and pins both sides of the branch.

Nothing on the memory backend: it cannot reach this node.

## TODO

- Move `safeToEvaluateTwice` to `rules/shared/` and import it from both rules.
- Split `trySortAbsorbViaIndexOrdering` into prepare and build steps; keep the composed export.
- Add `LimitChoiceNode` and its plan node type, with the attribute assertion and the cost `NOTE:`; handle it in required-columns and the validator.
- Add the emitter (on-demand branches, `resolveWindow`, licence-invariant comment) and register it.
- Fill the non-constant branch of the LimitOffset arm: declines, threshold search with its `NOTE:`, build the node.
- Update the comments and `docs/optimizer-retrieve.md` / `docs/module-authoring.md`.
- Add the end-to-end test.
- `yarn workspace @quereus/quereus run lint`, `yarn workspace @quereus/quereus run test`, `yarn workspace @quereus/store run test`.
