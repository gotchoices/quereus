description: AsyncGatherNode (physical N-ary relational combinator: `unionAll` + `crossProduct`) + emitter, validated. Manual-construction only — recognition rule for `unionAll` lands separately in 5.5; `zipByKey` parked in backlog. Reviewed and complete.
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/runtime/register.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md, docs/architecture.md
----

## What landed

The implementation handoff in the review ticket already covers the surface in detail (combinator semantics, attribute / FD / EC / binding / domain propagation, runtime helpers, registry wiring, doc updates, test coverage). That description still reflects the code on disk after this review. The headline:

- `AsyncGatherNode` (physical N-ary `RelationalPlanNode`) with discriminated-union combinator (`unionAll` | `crossProduct`), a positive-integer `concurrencyCap`, and an optional `preserveAttributeIds`. Construction validates: ≥ 2 children, positive integer cap, equal column counts for `unionAll`.
- `unionAll`: drops ordering / FDs / ECs / bindings / domains; attribute IDs mirror `children[0]`; per-column nullability is the OR across children; `isSet = false`.
- `crossProduct`: drops ordering; concatenates attributes; folds keys / FDs / ECs / bindings / domains pairwise with shifted indices and `closeConstantBindingsOverEcs` after each merge (mirrors `JoinNode(cross)`).
- Emitter `emitAsyncGather` wired in `register.ts`. Three helpers (`runUnionAll`, `runCrossProduct`, `cartesianProduct`) exported for unit testing. All branch driving goes through `ParallelDriver.drive()`, inheriting strict-fork bookkeeping, cancellation, error propagation, and consumer-break cleanup.

## Review findings

### What was checked

- The implement-stage commit diff (`991d180b`) read end-to-end before consulting the handoff.
- Plan-node + emitter interfaces (`PlanNode.physical` defaults, `RelationalPlanNode.getType`, `RuntimeContext` fork policy) cross-checked against `fork-contract.spec.ts`, `ParallelDriver.drive` and `eager-prefetch.ts` to verify the gather emitter mirrors the established pattern.
- The N-ary FD/EC/binding/domain fold against the binary `JoinNode(cross)` path (`join-utils.propagateJoinFds`, `inner`/`cross` branch).
- The `unionAll` attribute / `getType` shape against `SetOperationNode`.
- The validator's `logicalOnlyTypes` allowlist (the new node is not on it, so it passes through correctly).
- Lint: `yarn run lint` from `packages/quereus` — clean (exit 0, no output).
- Tests: `node test-runner.mjs --grep AsyncGather` — 29 passing, 1 pending (strict-fork-gated). `yarn test` from repo root — 3363 passing, 7 pending, 0 failing.

### Findings — minor (fixed inline)

1. **Class JSDoc overstated PhysicalProperties propagation.** The original docstring on `AsyncGatherNode` claimed that `concurrencySafe` and `expectedLatencyMs` "are propagated by the standard child-merge path established elsewhere". A repo-wide grep shows these fields are not defined on `PhysicalProperties` anywhere — the parallel-fanout track has not landed them yet. The implement handoff was honest about this gap but the in-file docstring stated it as fact. Rewrote the docstring to record the intended future merge (`AND` for `concurrencySafe`, `max` for `expectedLatencyMs`) as a forward-looking note and to enumerate the fields that *are* inherited from `PlanNode.physical`'s default child-merge today (`deterministic` / `idempotent` / `readonly`). Applied the same correction to the matching paragraph in `docs/runtime.md`.

### Findings — major (filed as follow-up)

2. **Validator + attribute-preserving N-ary nodes (pre-existing).** `validatePhysicalTree(node)` with default `{ validateAttributes: true }` throws `Duplicate attribute ID` for any parent that re-publishes a child's attribute IDs verbatim. This already affected `SetOperationNode`, `JoinNode` (inner/cross/right with verbatim concat), and `EagerPrefetchNode`; AsyncGatherNode joins that family. The implement spec compensates with `{ validateAttributes: false }` on its one explicit validator test. Filed `tickets/backlog/validator-attribute-preserving-nary-nodes.md` with three candidate fixes (per-node-class carve-out is the recommended surgical one) and an acceptance criterion that the gather's `{ validateAttributes: false }` workaround can be dropped once it lands.

### Notes for the 5.5 ticket author

These are not findings against ticket 5 — flagging so the recognition-rule author sees them while wiring `SetOperationNode(unionAll, …)` → `AsyncGatherNode(unionAll, …)`:

3. **`unionAll.getType()` diverges from `SetOperationNode.getType()`.** SetOperation returns `{ ...leftType, isSet: false }` for UNION ALL — left's columns verbatim (including left's nullability). AsyncGather computes per-column OR-nullability across all children. This is more correct, but it means rewriting a `SetOperationNode(unionAll, …)` to an `AsyncGatherNode(unionAll, …)` can flip a previously-NOT-NULL output column to nullable if any non-left child has a nullable column at that position. Downstream null-aware logic (Filter `IS NOT NULL` short-circuits, monotonicOn strictness via `isAssertedKey`) may produce different results. Worth checking when the recognition rule lands — possibly by mirroring SetOperationNode's nullability convention behind a flag during rewrite, or by leaving the more-correct AsyncGather behavior and re-running affected tests.

4. **CrossProduct FD fold skips `withKeyFds`.** `propagateJoinFds(cross, …)` layers `superkeyToFd(key, totalColumnCount)` for every preserved key onto the merged FDs. The gather's hand-rolled fold computes the Cartesian-product keys structurally (in `getType()`) but does not encode them as `key → all_other_cols` FDs in `computePhysical`. The handoff acknowledges this trade-off ("FD propagation re-uses the binary-join machinery in a fold. No bespoke N-ary FD primitives. Conservative but correct"). Acceptable for v1 — file a follow-up if the rule ticket finds the resulting FD set too lossy in practice.

### Findings — empty categories (called out explicitly)

- **Resource cleanup / cancellation:** `drive()` owns this; the gather's only role is forwarding cancellation through and not double-bumping strict-fork counters. Verified `runUnionAll` / `runCrossProduct` neither call `bumpParentForkCounter` directly nor open additional iterators outside `drive()`'s control. No issues.
- **Error handling:** propagation of branch throws is covered by `drive()` and exercised in `async-gather.spec.ts`. No issues.
- **DRY / SPP:** the cross-product fold inlines the same shifts + merge sequence used by `propagateJoinFds(cross, …)`. The implementer chose duplication over invoking the join-utils path because the gather's N-ary fold has no equivalent of `analyzeJoinKeyCoverage` and no equi-pairs to apply. The trade-off is documented in the handoff; the duplication is small. No change requested.
- **Type safety:** no `any` introduced. The discriminated-union `AsyncGatherCombinator` is exhaustively switched in `computePhysical` and `emitAsyncGather`.
- **Performance:** no quadratic surprises; the FD fold's `closeConstantBindingsOverEcs` runs once per merge step (N-1 times total). Cartesian product is N-ary lexicographic and skips work when any branch buffer is empty.
- **Memory:** `crossProduct` materialises every branch in memory before yielding; explicitly documented in both the node JSDoc and `docs/runtime.md`. Not a code change in this review.
- **Documentation:** `docs/runtime.md` and `docs/architecture.md` updated by the implementer; one docstring overstatement corrected in this review (see finding 1). The handoff's "How to exercise" example block matches the on-disk surface.

## Validation re-run after fixes

- `yarn run lint` from `packages/quereus`: clean.
- `node test-runner.mjs --grep AsyncGather`: 29 passing, 1 pending (strict-fork-gated; runs in `--fork-strict`).
- `yarn test` from repo root: 3363 passing, 7 pending, 0 failing.

## End
