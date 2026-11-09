description: A table module is now told which of its columns a query actually reads, so a column store can skip assembling the rest (for example for `select count(*)` or a one-column projection); review the analysis that decides the set, the late optimizer pass that delivers it, and the isolation layer's handling of it.
files: packages/quereus/src/planner/analysis/required-columns.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/vtab/index-info.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/strict-flags.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/optimizer/required-columns.spec.ts, packages/quereus-isolation/test/required-columns-merge.spec.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/planner/cost-additivity.spec.ts, docs/module-authoring.md, docs/optimizer.md, docs/runtime.md, docs/invariants.md, docs/plugins.md
----

# A scan request names the columns it reads — review handoff

## What changed

`FilterInfo` — the object a module's `query()` receives — gained `requiredColumns?: ReadonlySet<number>`: the table columns (0-based schema indexes) the finished plan reads from the rows that scan emits. **Absent means every column.** A module may fill only the listed columns and leave any valid SQL value (null is natural) in the rest; ignoring the field is always correct. Contract: `docs/module-authoring.md` § "Required columns".

How the set is computed (`planner/analysis/required-columns.ts`):

- A column is read if any `ColumnReferenceNode` anywhere in the plan names its attribute id (one plan-wide set — attribute ids are unique to their producer and pass through unchanged, so order and correlation don't matter), or if an operator consumes whole rows of a relation that carries it.
- "Read whole" starts at the statement result and passes down only through `Filter`, `Sort`, `LimitOffset`, `Alias`, `Cache` and joins (to each emitted side). `Project` and the three aggregate nodes read input only via expression children. **Every other node reads all of its relational inputs whole** — DML, `returning`, constraint checks, set ops, `distinct`, window, scalar subqueries, key-set semi join, ordinal slice, anything added later. Hash/merge joins also add their equi-pair attribute ids (read without an expression child).
- It relies on OPT-009 (every evaluated expression is a child).

Delivery: a new custom-`execute` optimizer pass `required-columns` (order 36, between Materialization 35 and FinalEstimates 37) runs `stampRequiredColumns`, which clones each changed scan via the new `TableAccessNode.withRequiredColumns` (keeps self-cost and every field) and re-mints only the path above it, memoized so shared subtrees stay shared. The stamp is **authoritative** (adds, changes or removes), so re-stamping a subtree against itself fixes a set computed for a larger plan.

## Decisions that deviate from the ticket — please weigh

- **No `BestAccessPlanRequest.requiredColumns`.** The ticket asked for it on the planning request. `getBestAccessPlan` runs while the plan above the scan is still being rewritten (grow-retrieve fires during the Structural pass), and a module has no channel to carry a planning-time answer into `query()`, so a request field could only be a stale estimate — the "documented field that is unreliable" problem the ticket raised about `colUsed`. The binding set goes on `FilterInfo` instead, which is literally the scan's request. If a module later wants a *pricing* hint (a covering-index plan, say), the same analysis could be run at the start of the Physical pass and attached to the request as advisory; not done.
- **`IndexInfo.colUsed` deleted** (always `0n`, and a bigint with `0n` would have been ambiguous between "none" and "unknown"). Removed from `filter-info.ts` builders, test literals in quereus and quereus-isolation, and `docs/plugins.md`.
- **The ticket's "test module run against a corpus" became a harness.** `QUEREUS_COLUMNS_STRICT=1` (`yarn test:columns-strict`, added to root `yarn check`) makes the scan emitter null every unlisted column for every module. That runs the whole quereus suite, sqllogic corpus included, as if every module honoured the field.

## Validation done

- `yarn test` (all workspaces): every workspace passed. The one long run was killed by the shell's time limit while starting `shared-ui` (Windows exit 0xC0000142, process failed to start); `shared-ui` (no test files), `sync-coordinator` (141) and `planviz` (22) were then re-run on their own and passed.
- `packages/quereus` full suite, normal: 11123 passing, 26 pending.
- `packages/quereus` full suite under `--columns-strict`: 11123 passing.
- Mutation check of the harness: making unknown operators *not* read inputs whole fails the strict sqllogic run.
- Mutation check of isolation widening: both new isolation cases fail with widening disabled.
- `yarn lint` in packages/quereus clean; `tsc -b tsconfig.build.json` clean; `node scripts/check-docs.mjs` OK.
- Not run: `yarn test:store` combined with `--columns-strict`; the full `yarn check`.

## Tests added

- `packages/quereus/test/optimizer/required-columns.spec.ts` — the set for: `select a` → {a}; `count(*)` → {}; unclaimed residual `b > 150` → {a, b}; PK range consumed as seek → {a} (constraint column not listed); join → both sides' keys; `order by c` → {a, c}; `delete`/`update` → absent.
- `packages/quereus-isolation/test/required-columns-merge.spec.ts` — an underlying module that nulls unlisted columns, read through a transaction's overlay: the primary-key merge keeps `id` (otherwise a shadowed row leaks); the secondary-index merge keeps the index key `b` (otherwise staged rows are misplaced). Each asserts what the module was asked for, so neither passes on an unnarrowed read.

## Existing tests changed

- `test/property.spec.ts` — the Tier 2 "isolated inner node" runner now calls `stampRequiredColumns(node)` before emitting a subtree on its own. The strict harness caught this: a subtree run standalone reads its output whole, which the full-plan stamp didn't account for.
- `test/optimizer/filter-selectivity.spec.ts` — the negative control asserted that only Materialization re-mints a Filter after PostOptimization; the new pass does too (the CTE body scan is narrowed to `cat, qty`). Added a whole-row CTE spelling as the positive control and asserted the narrowed one now needs `filter-selectivity-final`.
- `test/planner/cost-additivity.spec.ts` — the self-cost guard now also exempts `this.estimatedCost` (a clone carrying its *own* self-cost, as `withFilterInfo` does). The alternative, passing `undefined` like `withChildren`, would let a re-stamped `SeqScan` fall back to `indexInfoOutput.estimatedCost` and change its reported cost.

## Isolation layer

`IsolatedTable` forwards the narrow set unchanged on its fast path (no overlay). On a merged read it adds the PK columns (primary path) or PK + walked index key columns (secondary path) before querying the underlying, and strips the field from overlay queries — the overlay module is configurable and the merge reads its tombstone, PK and window columns.

## Things worth a hard look

- Are `Filter`/`Sort`/`LimitOffset`/`Alias`/`Cache`/joins really row pass-throughs whose emitters read nothing positionally? `Sort`'s keys and `LimitOffset`'s bounds are children; `JoinNode` evaluates its condition (child) and USING is not consumed at runtime; Bloom/Merge read `equiPairs` by id (added).
- Aggregates install a representative source row for HAVING / bare columns; those reads go through `ColumnReferenceNode`s, so they are counted. Confirm nothing in `emit/aggregate.ts` / `emit/hash-aggregate.ts` reads the source row positionally.
- Any production path that emits a *subtree* of an optimized plan as its own root would need to re-stamp. I found none (`emitPlanNode` callers outside emitters all take an `optimize()` result or a scalar), only the property test.
- Emitters that call a module's `query()` with a `FilterInfo` they build from a leaf's (asof, key-set semi join, ordinal slice override, eager prefetch, fan-out lookup) sit under nodes the analysis does not model, so their scans are read whole and unstamped — narrowing is lost there by design, not a hazard. Worth confirming none of them sits *under* a modelled pass-through with a scan that does get stamped.
- Precision left on the table, all conservative: `exists (select * …)` reads its subquery whole; `distinct`, set ops and windows read inputs whole; a Project's unused computed projection still counts its references (the runtime evaluates it).
- Cost: one extra whole-plan walk plus a re-mint of root→scan paths per `optimize()`. Not measured.
- Consumer: lamina (out of repo) still has to read `filterInfo.requiredColumns` in its `query()`.
