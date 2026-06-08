description: Batched/pipelined outer mode for `FanOutLookupJoinNode` — global in-flight semaphore, bounded outer read-ahead with consumer backpressure, per-outer-row context isolation (nested forking), order-preserving reorder buffer. Default stays `serial`; nothing in the optimizer constructs a batched node yet. Reviewed and completed.
files: packages/quereus/src/runtime/async-semaphore.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/runtime/async-semaphore.spec.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/runtime.md, docs/optimizer.md
----

## What landed

A second execution mode for `FanOutLookupJoinNode` (`outerMode: 'serial' | 'batched'`,
default `'serial'`) that overlaps lookups *across* outer rows. See the implement
commit (`git log --grep="ticket(implement): parallel-fanout-lookup-join-batched-outer"`)
for the full breakdown: `AsyncSemaphore` primitive, two `tuning.parallel` knobs
(`outerBatchConcurrency`=16, `maxOuterReadAhead`=64), the `runFanOutLookupJoinBatched`
driver (detached outer pump, nested per-row fork, permit-before-lock branch tasks,
seq-keyed reorder buffer, full cleanup), and the shared `composeOuterRow` helper.

Output order is identical to serial for both modes; nothing constructs a batched
node yet (recognition rule is the `parallel-fanout-batched-outer-recognition`
backlog ticket), so the golden-plan sweep is unchanged.

## Review findings

Reviewed the implement-stage diff with fresh eyes (semaphore, node, tuning, runtime
driver, scheduler interaction, both docs, all tests) across SPP/DRY/modularity,
concurrency liveness, resource cleanup, error handling, and type safety.

### Verified sound (no action)

- **`AsyncSemaphore`** — FIFO waiter handoff (permit handed to head waiter, never
  returned to the pool so a racing `acquire` can't jump the queue), single-shot
  idempotent release, integer `permits>=1` guard. Well covered by 6 unit cases.
- **Node threading** — `outerMode` added as the last positional ctor param;
  `validateConstruction` rejects unknown modes; `withChildren`/`toString`/
  `getLogicalAttributes` all thread it; `computePhysical`/ordering untouched.
  Verified by node-level threading/rejection tests.
- **Deadlock / liveness under cleanup** (focus #1) — traced. Permit-before-lock
  means every lock-holder also holds a permit, so a permit-holder blocked on a
  lock waits on another permit-holder that *will* release. On cleanup, `return()`
  on live branch iterators unwinds blocked branches → `finally` releases the
  permit → queued `acquire()` waiters resolve, see `aborted`, and immediately
  release, cascading the drain. No deadlock; queue always drains.
- **Lost-wakeup safety** (focus #2) — for both single-waiter signals
  (`emitWaiter`/`admitWaiter`) the predicate is re-checked immediately before
  `await waitX()` with no intervening `await` between the check and installing the
  waiter. No lost wakeup.
- **Strict-fork counter bookkeeping** (focus #3) — nested fork
  (`rctx → rowCtx → branch forks`) bumps in admit order and drops in `runRow`'s
  `finally` in the correct reverse order (drop branch counters → close row slot →
  drop rctx counters), so `rowSlot.close()` mutates `rowCtx.context` only when its
  fork count is 0. `dropParentForkCounter(null)` is a no-op (verified in
  `strict-fork.ts`), so the `branchCount`-guarded nulls are safe. Balanced on the
  error branch too (single `finally`). Passes under `QUEREUS_FORK_STRICT=1`.
- **Per-row binding isolation** — `createRowSlot` allocates a fresh boxed `ref`
  per call (confirmed in `context-helpers.ts`); each row's getter closes over its
  own box and `rowCtx`'s slot shadows any inherited outer attribute. The
  "isolates each row's outer binding" test would fail under the unsafe
  shared-slot approach, so it is a real guard.
- **Docs** — `docs/runtime.md` § Outer execution modes and `docs/optimizer.md`
  tuning-knob list accurately describe the landed behavior, defaults, and the
  deferred recognition rule. The `prefetchAsyncIterable`/`BoundedPrefetchBuffer`
  cross-references are correct (both symbols exist).

### Minor — fixed inline this pass

- **Eaten `undefined`-reason rejection (don't-eat-exceptions violation).** The
  driver used `firstError === undefined` and `branchError === undefined` as
  "no error" sentinels. A branch rejecting with `undefined` left both unset, so
  the rejection was silently swallowed and the branch treated as a zero-row miss
  (NULL-padded / dropped) instead of propagating. Replaced with explicit boolean
  flags (`errored`, `hasBranchError`) — mirrors `ParallelDriver`'s `hadError`
  discipline. Added regression test *"propagates a branch rejection even when the
  reason is undefined"*. Build + lint clean; full suite 3497 passing.

### Major — filed (deferred; nothing constructs a batched node yet)

- **Outer-source mutation of shared `rctx.context` during the pump.** The
  scheduler runs every instruction against one shared `RuntimeContext`, and the
  batched pump pulls the outer source *concurrently* with live row forks (serial
  mode never overlapped these). The per-row outer slot is correctly isolated, so
  branch correlations on outer columns are safe, but (a) a branch reading a
  non-outer context entry the outer source mutates mid-pump could observe a torn
  value, and (b) when the fan-out is nested under another fork (strict-wrapped
  `rctx.context`), the outer source's mutation while row forks hold the bump
  counter would throw a strict-fork violation — which CI would hit once a real
  outer plan runs batched under `QUEREUS_FORK_STRICT=1`. Not reachable today
  (only array-backed test outer sources, and no rule builds a batched node).
  Documented as a must-verify item in
  `tickets/backlog/parallel-fanout-batched-outer-recognition.md`.

### Minor — noted, not fixed

- **Weak cleanup assertion in batched tests.** The consumer-break / branch-error
  batched tests assert `ctx.context.size === 0`, but batched mode installs per-row
  slots on forked `rowCtx`s, never on the parent `ctx` — so the assertion is
  trivially true and does not actually verify per-row slot teardown. The
  "isolates each row's outer binding" test does provide real isolation coverage;
  strengthening the teardown assertion would need a close()-tracking hook (low
  value, left as-is).
- **Timing tests are load-sensitive** (cross-row overlap `<320ms`, serial contrast
  `>M×L×0.6`, budget peaks). Wide CI bands matching the existing parallel-driver /
  eager-prefetch timing-test style; could flake on a heavily loaded runner.
  Acknowledged in the implement handoff; no change.

## Validation status

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` (full suite) — **3497 passing, 0 failing,
  10 pending** (was 3496; +1 from the new regression test). Golden-plan sweep
  unchanged (serial remains default).
- Fanout + semaphore specs pass under default and `QUEREUS_FORK_STRICT=1`.

## Deferred follow-ups (already ticketed)

- `parallel-fanout-batched-outer-recognition` (backlog) — the rule that *chooses*
  batched, plus the outer-source/shared-context verification noted above.
- `parallel-fanout-lookup-join-cross-mode` (backlog) — streaming `cross` + batched.
