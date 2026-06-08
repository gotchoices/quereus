description: FanOutLookupJoinNode (physical: for one outer row, fork N parameterized child sub-plans and assemble a wide row from each branch's at-most-one lookup result) + emitter, validated. v1 supports atMostOne-left / atMostOne-inner branch modes; manual-construction only — recognition rule lands in 4.5. Reviewed and complete.
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/runtime/register.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/runtime.md, docs/architecture.md
----

## What landed

The implementation handoff in the review ticket covers the surface in detail (branch-mode discrimination, attribute / FD propagation, lock policy, outer-row binding propagation, runtime helpers, registry wiring, doc updates, test coverage). That description still reflects the code on disk after this review. The headline:

- **`FanOutLookupJoinNode`** (physical `RelationalPlanNode`) — for one outer row, forks N parameterized child sub-plans, drives them concurrently via `ParallelDriver.drive()` (bounded by `concurrencyCap`), validates each branch's at-most-one invariant, and composes a wide result row. Construction validates: ≥ 1 branch, positive-integer `concurrencyCap`, per-branch `outputAttrs.length === child.getAttributes().length`, and (when supplied) `preserveAttributeIds.length === outer + Σ branches.outputAttrs`.
- **Branch modes (v1).** `atMostOne-left` (NULL-pad on miss, keep outer row) and `atMostOne-inner` (drop outer row on miss). Both share the runtime `atMostOne` invariant — > 1 row throws `QuereusError(StatusCode.CONSTRAINT)`. The 1:n relational `cross` mode is parked in `tickets/backlog/parallel-fanout-lookup-join-cross-mode.md`; the former `array` mode collapsed into recognition-only work (`tickets/backlog/parallel-fanout-lookup-join-aggregate-branch-recognition.md`) since a correlated `json_group_array` subquery is already an at-most-one branch.
- **Attribute layout.** Outer attrs then each branch's `outputAttrs` in declared order; `atMostOne-left` branches mark their slice nullable. `preserveAttributeIds`, when supplied, fixes the entire wide layout verbatim so rewrites can preserve a surrounding `ProjectNode`'s IDs.
- **FD/EC/binding/domain propagation.** Left-to-right per-branch fold via `propagateJoinFds(joinType=left|inner, …, equiPairs=[], preservedKeys=[])`. With empty equi-pair lists the propagation is correct but conservative — outer-only FDs survive `atMostOne-left`, merged-shifted FDs survive `atMostOne-inner`. The recognition rule (4.5) will tighten this without changing the emitter once it attaches FK→PK alignment to the branch spec.
- **Emitter `emitFanOutLookupJoin`** wired in `register.ts`. `runFanOutLookupJoin` is exported for direct unit testing. Per outer row: install the outer `RowSlot` on the parent `rctx.context` *before* forking so each fork's snapshot carries the binding; call `resolveBranchFactories` to wrap non-`concurrencySafe` branches in `acquireConnectionLock`; fork N times via `ParallelDriver.fork`; drive concurrently via `ParallelDriver.drive` (bounded by `concurrencyCap`); collect per-branch buffers; validate `atMostOne`; drop the outer row when any `atMostOne-inner` branch produced zero; compose and yield.
- **Lock wrap** uses an `async function*` so the lock acquires on the first pull and the release runs in `finally` whether the inner iterator completes, throws, or is `return()`-closed.

## Review findings

### What was checked

- The implement-stage commit diff (`074abc51`) read end-to-end before consulting the handoff.
- `FanOutLookupJoinNode` plan-node code path (construction validation, attribute layout, `getType`, `getRelations`, `withChildren`, `computePhysical`, `toString`, `getLogicalAttributes`) cross-checked against the sibling `AsyncGatherNode` and the binary `JoinNode`/`propagateJoinFds` contract.
- `emitFanOutLookupJoin` + `runFanOutLookupJoin` + `withConnectionLock` + `resolveBranchFactories` against `ParallelDriver.fork`/`drive`, `createRowSlot`, `acquireConnectionLock`, `Scheduler`/`emitCallFromPlan`, and the strict-fork bookkeeping primitives.
- The `RowSlot` lifecycle vs strict-fork: the outer slot is installed on `rctx.context` *before* the per-row loop, mutated via `outerSlot.set(row)` (which only mutates the boxed ref — does **not** touch the parent `RowContextMap`, so no strict-fork violation), and closed in `finally` after `driver.drive` has dropped its parent-fork counter. Verified per outer iteration — the per-iteration fork sequence (`set(row)` → `fork` → `drive` → consume) leaves no overlap between an active parent-fork counter and a parent-map mutation.
- The `withConnectionLock` chain-of-tails contract: even when an acquirer is interrupted (consumer break / driver close-all calls `iter.return()`), the `async function*` body's `finally` always fires and the second-in-line acquirer's prior-tail await completes naturally. No deadlock on cancellation; no orphaned tail in the per-connection chain.
- Scheduler concurrency: each branch is emitted via `emitCallFromPlan` which builds a per-branch `Scheduler`. `Scheduler.run(ctx)` allocates a fresh `instrArgs` array per invocation — concurrent `program.run(fork[i])` calls across sibling branches share only the read-only `instructions` array, not run-time state. Safe.
- Module concurrency / lock target resolution: distinct connections never contend (`connectionLockTails` is a `WeakMap` keyed by identity); `concurrencyKey` overrides `rctx.activeConnection`; when neither is available the branch runs raw — fall-through behavior is correct (nothing to serialize on) but was previously undocumented in `docs/runtime.md` (see finding 1 below).
- The validator's `logicalOnlyTypes` allowlist: the new node is not on it, so it passes through correctly. The node deliberately re-publishes outer + branch attribute IDs, so the existing `{ validateAttributes: false }` workaround applies for the same reason as `FilterNode` / `EagerPrefetchNode` / `AsyncGatherNode` (see backlog `validator-attribute-preserving-nary-nodes`).
- `docs/runtime.md` § *FanOutLookupJoinNode* and `docs/architecture.md` bullet read against the on-disk surface.
- Lint: `yarn run lint` from `packages/quereus` — clean (exit 0, no output).
- Tests: `yarn test --grep "FanOutLookupJoin"` from `packages/quereus` — 23 passing, 2 pending (strict-fork-gated); `yarn test` from `packages/quereus` — 3386 passing, 9 pending, 0 failing; `QUEREUS_FORK_STRICT=1 yarn test` — 3395 passing, 0 failing (the 2 strict-fork-gated FanOut cases plus the new error-propagation case run); `yarn build` from repo root — clean across all packages.

### Findings — minor (fixed inline)

1. **Lock-target fall-through undocumented in `docs/runtime.md`.** When a branch declares `concurrencySafe: false` but neither `connectionKey` nor `rctx.activeConnection` is available, `resolveBranchFactories` falls through and the branch runs raw — there is no identity to key `acquireConnectionLock` on, so serialization cannot be enforced. The implementer's "Honest gaps" section in the review ticket called this out but `docs/runtime.md` only described the present-key paths. Added one sentence to the "Lock policy" paragraph naming the fall-through case and the contexts it can arise from (CTE-materialization / const-evaluation paths that run without an established connection).

2. **Two test-coverage gaps in the implement test set.** The existing 21 + 2 cases hit the common paths well, but the empty-outer-source code path (the `for await` body never executes — only the slot create + finally close runs) and end-to-end branch-error propagation through the FanOut wrapper (the underlying driver test covers it, but the FanOut layer adds an outer slot close in `finally` and a per-iteration result buffer that could silently break) were not exercised. Added two inline tests in `fanout-lookup-join.spec.ts`:
   - `empty outer source` — confirms zero rows out, zero branch invocations, and `ctx.context.size === 0` after the slot's `close()` runs in `finally`.
   - `branch error propagation` — one branch throws, sibling branch sleeps with a `finally`-tracked close flag; asserts the thrown error propagates verbatim, the sibling's `finally` ran (driver `closeAll` reached it), and the outer slot is closed.

### Findings — major

None. No newly filed tickets in this review.

### Notes for the 4.5 ticket author

These are not findings against ticket 4 — flagging so the recognition-rule author sees them while wiring `JoinNode(left|inner, FK→PK)` → `FanOutLookupJoinNode(…)`:

3. **`computePhysical` is wired for an upcoming equi-pair surface.** The fold currently passes `equiPairs=[]` and `preservedKeys=[]` to `propagateJoinFds`, so cross-branch FDs and key-FDs are not derived. The handoff already calls this out as deliberate v1 scope; the surface the rule should grow on `FanOutBranchSpec` is the (left attrId, right attrId) pair list per branch (i.e. the FK columns on the outer side and PK columns on the branch side). Once that's plumbed, the existing `for (let i = 0; i < this.branches.length; i++) { … propagateJoinFds(joinType, leftPhys, rightPhys, equiPairsForBranch, leftColCount, totalCols, preservedKeysForBranch) … }` body needs no structural change.

4. **`expectedLatencyMs` and `concurrencySafe` are not on `PhysicalProperties` yet.** The cost-gate hook that the recognition rule will need to decide when to rewrite a join chain into `FanOutLookupJoinNode` does not have these fields to read. Same status as for `AsyncGatherNode`: the parallel-fanout track has not landed the fields. When 4.5 (or a sibling ticket) adds them, the intended merge for FanOut is `max` across branches for `expectedLatencyMs` and `AND` across branches for `concurrencySafe`; this node's `computePhysical` should be updated to override and project them at that time.

5. **Per-iteration wrapping allocation in `resolveBranchFactories`.** Called once per outer row to bind the lock target. For very narrow outer streams this is negligible; for hot wide loops the rule layer could pre-compute a table-keyed map of wrapped factories and reuse it. v1 prioritises clarity; defer until measured.

### Findings — empty categories (called out explicitly)

- **Resource cleanup / cancellation:** `driver.drive()` owns branch close-all, and `withConnectionLock`'s `async function*` body always releases in `finally`. The outer `runFanOutLookupJoin`'s `try { … } finally { outerSlot.close(); }` always runs even on iterator `return()`, abort, or branch throw. Verified by reading the structure end-to-end; new inline tests exercise the empty-outer and branch-throw paths to lock the contract in. No issues.
- **Error handling:** branch throws propagate through `driver.drive` and the FanOut wrapper preserves the original error verbatim (no wrapping). Sibling iterators are closed via `closeAll`. Outer slot closes in the outer generator's `finally`. New inline test pins this. No issues.
- **DRY / SPP:** the FD fold reuses `propagateJoinFds` rather than rolling a bespoke N-ary primitive, consistent with the trade-off `AsyncGatherNode` made. The emitter cleanly separates `withConnectionLock` (lock wrap), `resolveBranchFactories` (per-iteration binding), and `runFanOutLookupJoin` (orchestration). No duplication worth collapsing.
- **Type safety:** no `any` introduced. `FanOutBranchMode` is a string-literal union; the cast `lockTarget as VirtualTableConnection` is documentation-only since `acquireConnectionLock` keys a `WeakMap` by identity and tests rely on this by passing arbitrary identity objects.
- **Performance:** no surprises beyond what the handoff documents. The per-iteration `resolveBranchFactories` allocation is acknowledged; FD propagation runs once per branch per `computePhysical` invocation (i.e. once per planning pass). Buffer allocation per outer row is O(N) for the `branchBuf` array, which is fine.
- **Memory:** at-most-one bound per branch means the per-row buffer is O(N) cells, not O(N × rows). No materialisation beyond one row per branch per outer row.
- **Scalability vs. nested fanouts:** each `FanOutLookupJoinNode` emit creates its own `ParallelDriver` instance and tracks its own per-iteration fork counters via the driver; nesting another FanOut as a branch's child sub-plan works because each level's `bumpParentForkCounter` is keyed per-context-map. Verified by reading `driveImpl`'s parent-counter handling.
- **Documentation:** `docs/runtime.md` and `docs/architecture.md` updated by the implementer; one fall-through gap closed in this review (see finding 1). The handoff's "Usage / shape" example block matches the on-disk surface.

## Validation re-run after fixes

- `yarn run lint` from `packages/quereus`: clean (exit 0, no output).
- `yarn test --grep "FanOutLookupJoin"` from `packages/quereus`: 23 passing, 2 pending (strict-fork-gated).
- `QUEREUS_FORK_STRICT=1 yarn test --grep "FanOutLookupJoin"`: 25 passing.
- `yarn test` (full suite, normal mode): 3386 passing, 9 pending, 0 failing.
- `yarn build` from repo root: clean across all packages.

## End
